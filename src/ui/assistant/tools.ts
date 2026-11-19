/** How tool activity reads in the conversation: a plain label and an icon. */
import {
  Mouse,
  History,
  AppWindow,
  FolderOpen,
  FileText, Brain, Calendar, Cpu, Globe, GitBranch, House, Keyboard, ListChecks, Mail, MessageCircle, MousePointerClick, Music, Puzzle, ScanEye, Settings2, Stethoscope, Volume2, Wrench, type LucideIcon,
} from "lucide-react";

const LABELS: Record<string, string> = {
  launch_app: "Opened an app",
  close_app: "Closed an app",
  focus_window: "Switched window",
  find_apps: "Looked up apps",
  refresh_app_list: "Rescanned apps",
  launch_game: "Launched a game",
  open_path: "Opened a file or folder",
  list_folder: "Looked in a folder",
  find_files: "Searched your files",
  move_files: "Moved files",
  rename_file: "Renamed a file",
  make_folder: "Made a folder",
  delete_files: "Sent to the Recycle Bin",
  tidy_folder: "Tidied a folder",
  undo_file_changes: "Undid file changes",
  search_documents: "Searched your documents",
  read_document: "Read a document",
  open_website: "Opened a website",
  web_search: "Searched the web",
  read_web_page: "Read a web page",
  look_at_screen: "Looked at the screen",
  look_back: "Looked back at the screen",
  read_screen_text: "Read the screen",
  read_app_controls: "Read the app's controls",
  use_control: "Used a control",
  click_on_screen: "Clicked on screen",
  use_named_control: "Used a control",
  scroll_screen: "Scrolled",
  hover_on_screen: "Pointed at something",
  drag_on_screen: "Dragged on screen",
  press_keys: "Pressed keys",
  type_text: "Typed text",
  set_volume: "Changed volume",
  set_muted: "Changed mute",
  get_system_stats: "Checked system",
  get_running_apps: "Checked running apps",
  diagnose_pc: "Ran diagnostics",
  remember: "Saved to memory",
  recall_memories: "Checked memory",
  forget_memory: "Forgot a memory",
  save_note: "Saved a note",
  search_notes: "Searched notes",
  read_note: "Read a note",
  search_conversations: "Searched past conversations",
  update_plan: "Updated the plan",
  start_background_task: "Started a background task",
  track_task: "Started tracking a task",
  send_to_phone: "Sent to your phone",
  lock_pc: "Locked the PC",
  power_action: "Power action",
  set_quiet_mode: "Changed quiet mode",
  open_settings_page: "Opened Windows settings",
  run_routine: "Ran a routine",
  get_datetime: "Checked the time",
  spotify_play: "Played on Spotify",
  spotify_control: "Controlled Spotify",
  spotify_now_playing: "Checked Spotify",
  home_find: "Checked the smart home",
  home_control: "Controlled a device",
  home_history: "Checked device history",
  gmail_search: "Searched email",
  gmail_read: "Read an email",
  gmail_draft: "Drafted an email",
  calendar_events: "Checked the calendar",
  calendar_add_event: "Added a calendar event",
  github_notifications: "Checked GitHub",
  github_issues: "Listed GitHub issues",
  github_pr_status: "Checked a pull request",
  github_create_issue: "Opened a GitHub issue",
  discord_channels: "Listed Discord channels",
  discord_read: "Read Discord",
  discord_send: "Posted on Discord",
  list_background_tasks: "Checked background tasks",
  cancel_background_task: "Cancelled a background task",
};

export function toolLabel(name: string): string {
  if (LABELS[name]) return LABELS[name];
  if (name.startsWith("mcp_")) return name.replace(/^mcp_([a-z0-9]+)_/, (_m, s: string) => `${s}: `).replace(/_/g, " ");
  const t = name.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function toolIcon(name: string): LucideIcon {
  if (/^(launch_app|close_app|focus_window|find_apps|refresh_app_list|launch_game|open_path|list_windows)$/.test(name)) return AppWindow;
  if (/^(search_documents|read_document)$/.test(name)) return FileText;
  if (/^(list_folder|find_files|move_files|rename_file|make_folder|delete_files|tidy_folder|undo_file_changes)$/.test(name)) return FolderOpen;
  if (/^(web_search|read_web_page|open_website)$/.test(name)) return Globe;
  if (name === "look_back") return History;
  if (/^(look_at_screen|read_screen_text|read_app_controls)$/.test(name)) return ScanEye;
  if (/^(use_control|use_named_control|click_on_screen|hover_on_screen|drag_on_screen)$/.test(name)) return MousePointerClick;
  if (name === "scroll_screen") return Mouse;
  if (/^(press_keys|type_text)$/.test(name)) return Keyboard;
  if (/^(set_volume|set_muted)$/.test(name)) return Volume2;
  if (/^(get_system_stats|get_running_apps|get_gpu_stats)$/.test(name)) return Cpu;
  if (name === "diagnose_pc") return Stethoscope;
  if (/^(remember|recall_memories|forget_memory|save_note|search_notes|read_note|delete_note|search_conversations)$/.test(name)) return Brain;
  if (/(plan|task|routine)/.test(name)) return ListChecks;
  if (name.startsWith("spotify_")) return Music;
  if (name.startsWith("home_")) return House;
  if (name.startsWith("gmail_")) return Mail;
  if (name.startsWith("calendar_")) return Calendar;
  if (name.startsWith("github_")) return GitBranch;
  if (name.startsWith("discord_")) return MessageCircle;
  if (name.startsWith("mcp_")) return Puzzle;
  if (/(lock|power|settings|quiet)/.test(name)) return Settings2;
  return Wrench;
}

/** First line of a result, for the one-line summary. */
export const summary = (s: string, n = 140) => {
  const line = s.replace(/<<<[\s\S]*?>>>/g, "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > n ? `${line.slice(0, n)}…` : line;
};
