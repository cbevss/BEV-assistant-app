/**
 * The phone's live screen as real video (WebRTC, up to 60 fps), instead of a
 * picture every second. The phone asks ("hello"), the PC offers a video of the
 * screen, they agree through sealed messages via the BEV account server, then
 * the video goes straight between them (encrypted; through a TURN relay only
 * when the server has one and a direct path can't be found).
 *
 * The screen comes from the webview's own screen capture (getDisplayMedia, which
 * BEV's WebView2 picks automatically: see tauri.conf additionalBrowserArgs) at
 * 60 fps. If that isn't available, frames come from BEV's native capture
 * drawn onto a canvas, as fast as the PC manages (usually 20-30 fps).
 */
import { invoke } from "@tauri-apps/api/core";
import { api } from "./client";
import { openPhone, sealPhone } from "./phoneCrypto";

export const LIVE_FPS = 60;
const MAX_BITRATE = 8_000_000;

type Signal =
  | { type: "hello"; sid: string; display?: string }
  | { type: "answer"; sid: string; sdp: string }
  | { type: "ice"; sid: string; c: RTCIceCandidateInit }
  | { type: "bye"; sid: string };

export interface LiveVideoDeps {
  token(): Promise<string | null>;
  key(): CryptoKey | null;
  userId(): string;
  /** The live screen is wanted (until this time). */
  until(): number;
  /** Video is flowing (or stopped): the picture-every-second fallback pauses while it is. */
  onVideo(on: boolean): void;
  log(text: string): void;
}

/** Which capture to use for what the phone asked to see. Pure; tested. */
export function sourceFor(display: string): "screen" | "frames" {
  // The webview's capture shows one whole screen; "every screen" needs BEV's own stitched frames.
  return display === "all" ? "frames" : "screen";
}

/** Older hellos in a batch are from sessions the phone already replaced: only the newest counts. Pure; tested. */
export function latestHelloOnly<T extends { type: string; sid: string }>(signals: T[]): T[] {
  const last = [...signals].reverse().find((s) => s.type === "hello");
  return signals.filter((s) => s.type !== "hello" || s === last).filter((s) => !last || s.type === "hello" || s.sid === last.sid || s.type === "bye");
}

export class LiveVideo {
  private cursor = -1;
  private pc: RTCPeerConnection | null = null;
  private sid = "";
  private stream: MediaStream | null = null;
  private stopFrames: (() => void) | null = null;
  private running = false;
  private pending: RTCIceCandidateInit[] = [];

  constructor(private d: LiveVideoDeps) {}

  /** Listen for the phone's set-up messages while the live screen is wanted. */
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      // Start from the beginning of what the server still keeps (the last 2 minutes): the phone usually says
      // hello before the PC hears that the live screen is wanted, and that hello mustn't be skipped.
      if (this.cursor < 0) this.cursor = 0;
      while (this.d.until() > Date.now()) {
        await this.poll().catch(() => {});
        await new Promise((r) => setTimeout(r, this.pc && this.pc.connectionState === "connected" ? 1500 : 350));
      }
    } finally {
      this.running = false;
      this.close();
    }
  }

  private async poll() {
    const t = await this.d.token();
    const key = this.d.key();
    if (!t || !key) return;
    const r = await api.phoneRtcInbox(t, Math.max(0, this.cursor));
    const signals: Signal[] = [];
    for (const m of r.messages) {
      this.cursor = Math.max(this.cursor, m.id);
      const s = await openPhone<Signal>(key, "rtc_pc", this.d.userId(), m.iv, m.ct).catch(() => null);
      if (s) signals.push(s);
    }
    for (const s of latestHelloOnly(signals)) await this.on(s).catch((e) => this.d.log(`Live video: ${e instanceof Error ? e.message : String(e)}`));
  }

  private async signal(s: Record<string, unknown>) {
    const t = await this.d.token();
    const key = this.d.key();
    if (!t || !key) return;
    const e = await sealPhone(key, "rtc_phone", this.d.userId(), s);
    await api.phoneRtcSend(t, "phone", e.iv, e.ct);
  }

  private async on(s: Signal) {
    if (s.type === "hello") {
      // The phone repeats its hello until it gets an offer: answer each session once.
      if (s.sid === this.sid && this.pc && this.pc.connectionState !== "failed") return;
      return this.offer(s.sid, s.display ?? "current");
    }
    if (s.sid !== this.sid || !this.pc) return;
    if (s.type === "answer") {
      await this.pc.setRemoteDescription({ type: "answer", sdp: s.sdp });
      for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
    } else if (s.type === "ice") {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(s.c).catch(() => {});
      else this.pending.push(s.c);
    } else if (s.type === "bye") this.close();
  }

  private async offer(sid: string, display: string) {
    this.close();
    this.sid = sid;
    const t = await this.d.token();
    const ice = t ? await api.phoneIce(t).catch(() => null) : null;
    const pc = new RTCPeerConnection({ iceServers: ice?.iceServers ?? [{ urls: "stun:stun.cloudflare.com:3478" }] });
    this.pc = pc;
    const track = await this.source(display);
    const sender = pc.addTrack(track, this.stream!);
    pc.onicecandidate = (e) => {
      if (e.candidate) void this.signal({ type: "ice", sid, c: e.candidate.toJSON() }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      if (pc.connectionState === "connected") this.d.onVideo(true);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.d.onVideo(false);
        if (pc.connectionState === "failed") this.d.log("Live video couldn't connect, so your phone gets pictures instead.");
      }
    };
    // Smooth first: hold the frame rate, let the resolution give when the network's slow.
    const params = sender.getParameters();
    params.degradationPreference = "maintain-framerate";
    params.encodings = (params.encodings?.length ? params.encodings : [{}]).map((e) => ({ ...e, maxBitrate: MAX_BITRATE, maxFramerate: LIVE_FPS }));
    await sender.setParameters(params).catch(() => {});
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.signal({ type: "offer", sid, sdp: offer.sdp ?? "", relay: !!ice?.relay });
  }

  /** The screen as a video track: the webview's 60 fps capture, else BEV's own frames on a canvas. */
  private async source(display: string): Promise<MediaStreamTrack> {
    if (sourceFor(display) === "screen" && navigator.mediaDevices?.getDisplayMedia) {
      try {
        // If WebView2 shows its screen picker instead of picking by itself, nobody's there to click it: give up after 6s.
        const stream = await Promise.race([
          navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: LIVE_FPS, max: LIVE_FPS }, width: { max: 2560 }, height: { max: 1440 } },
            audio: false,
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the screen picker didn't answer")), 6000)),
        ]);
        const track = stream.getVideoTracks()[0];
        if (track) {
          track.contentHint = "motion";
          this.stream = stream;
          return track;
        }
      } catch (e) {
        this.d.log(`Fast screen capture isn't available (${e instanceof Error ? e.message : String(e)}); using BEV's own capture.`);
      }
    }
    return this.canvasTrack(display);
  }

  private canvasTrack(display: string): MediaStreamTrack {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const g = canvas.getContext("2d", { alpha: false })!;
    const stream = canvas.captureStream(LIVE_FPS);
    this.stream = stream;
    let on = true;
    this.stopFrames = () => {
      on = false;
    };
    // No timers (a hidden window throttles them): each frame starts when the last one's drawn.
    void (async () => {
      while (on) {
        try {
          const bytes = await invoke<ArrayBuffer>("live_frame", { target: display, maxEdge: 1600, quality: 70 });
          const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          g.drawImage(bmp, 0, 0);
          bmp.close();
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
    const track = stream.getVideoTracks()[0];
    track.contentHint = "detail";
    return track;
  }

  close() {
    this.stopFrames?.();
    this.stopFrames = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
      this.d.onVideo(false);
    }
    this.pending = [];
  }
}
