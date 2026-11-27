// bev-wa: BEV's WhatsApp linked device. It signs in to the user's own WhatsApp account
// as a linked device (like WhatsApp Web, by scanning a QR code once) and talks to the BEV
// app over stdin/stdout, one JSON object per line.
//
// From BEV (stdin):
//
//	{"id":"1","cmd":"send","to":"447700900123 or a chat id","text":"hi"}
//	{"id":"2","cmd":"chats"}                 recent chats with unread counts
//	{"id":"3","cmd":"read","chat":"Mum","max":15}
//	{"id":"4","cmd":"logout"}
//
// To BEV (stdout):
//
//	{"event":"qr","png":"data:image/png;base64,..."}    scan this with the phone
//	{"event":"ready","me":"447..."}
//	{"event":"message","chat":"Mum","chatId":"...","from":"Mum","text":"...","time":171...}
//	{"event":"loggedOut"}
//	{"reply":"1","ok":true,"data":...} / {"reply":"1","ok":false,"error":"..."}
//
// It only ever acts when BEV asks (no bulk sending), and keeps messages in memory only;
// the sign-in is stored in the folder given by -data.
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

type msg struct {
	Chat   string `json:"chat"`
	ChatID string `json:"chatId"`
	From   string `json:"from"`
	Text   string `json:"text"`
	Time   int64  `json:"time"`
	Mine   bool   `json:"mine"`
}

type chat struct {
	Name    string `json:"name"`
	ChatID  string `json:"chatId"`
	Unread  int    `json:"unread"`
	Preview string `json:"preview"`
	Time    int64  `json:"time"`
}

var (
	out     = json.NewEncoder(os.Stdout)
	outMu   sync.Mutex
	histMu  sync.Mutex
	history = map[string][]msg{} // chat id -> latest messages (memory only)
	unread  = map[string]int{}
	names   = map[string]string{} // chat id -> name
)

const keep = 50

func emit(v any) {
	outMu.Lock()
	defer outMu.Unlock()
	_ = out.Encode(v)
}

func chatName(cli *whatsmeow.Client, jid types.JID, pushName string) string {
	ctx := context.Background()
	if jid.Server == types.GroupServer {
		if info, err := cli.GetGroupInfo(ctx, jid); err == nil && info.Name != "" {
			return info.Name
		}
		return jid.User
	}
	if c, err := cli.Store.Contacts.GetContact(ctx, jid); err == nil && c.Found {
		for _, n := range []string{c.FullName, c.FirstName, c.PushName, c.BusinessName} {
			if n != "" {
				return n
			}
		}
	}
	if pushName != "" {
		return pushName
	}
	return "+" + jid.User
}

func textOf(m *waE2E.Message) string {
	if m == nil {
		return ""
	}
	switch {
	case m.GetConversation() != "":
		return m.GetConversation()
	case m.GetExtendedTextMessage() != nil:
		return m.GetExtendedTextMessage().GetText()
	case m.GetImageMessage() != nil:
		return strings.TrimSpace("[photo] " + m.GetImageMessage().GetCaption())
	case m.GetVideoMessage() != nil:
		return strings.TrimSpace("[video] " + m.GetVideoMessage().GetCaption())
	case m.GetAudioMessage() != nil:
		return "[voice message]"
	case m.GetDocumentMessage() != nil:
		return "[file] " + m.GetDocumentMessage().GetFileName()
	case m.GetStickerMessage() != nil:
		return "[sticker]"
	case m.GetLocationMessage() != nil:
		return "[location]"
	case m.GetContactMessage() != nil:
		return "[contact] " + m.GetContactMessage().GetDisplayName()
	}
	return ""
}

func remember(m msg) {
	histMu.Lock()
	defer histMu.Unlock()
	h := append(history[m.ChatID], m)
	if len(h) > keep {
		h = h[len(h)-keep:]
	}
	history[m.ChatID] = h
	names[m.ChatID] = m.Chat
	if m.Mine {
		unread[m.ChatID] = 0
	} else {
		unread[m.ChatID]++
	}
}

func findChat(query string) (string, bool) {
	q := strings.ToLower(strings.TrimSpace(query))
	histMu.Lock()
	defer histMu.Unlock()
	for id, n := range names {
		if strings.ToLower(n) == q || id == query {
			return id, true
		}
	}
	for id, n := range names {
		if strings.Contains(strings.ToLower(n), q) {
			return id, true
		}
	}
	return "", false
}

// toJID turns a phone number (any format, with country code) or chat id into a JID.
func toJID(cli *whatsmeow.Client, to string) (types.JID, error) {
	if strings.Contains(to, "@") {
		return types.ParseJID(to)
	}
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, to)
	if len(digits) >= 8 {
		res, err := cli.IsOnWhatsApp(context.Background(), []string{"+" + digits})
		if err != nil {
			return types.JID{}, err
		}
		if len(res) == 0 || !res[0].IsIn {
			return types.JID{}, fmt.Errorf("+%s isn't on WhatsApp", digits)
		}
		return res[0].JID, nil
	}
	if id, ok := findChat(to); ok {
		return types.ParseJID(id)
	}
	return types.JID{}, fmt.Errorf("couldn't find a chat called %q yet. Use their number, or wait for a message from them", to)
}

func qrPNG(code string) string {
	png, err := qrcode.Encode(code, qrcode.Medium, 320)
	if err != nil {
		return ""
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
}

func main() {
	data := flag.String("data", ".", "folder to keep the sign-in in")
	flag.Parse()
	_ = os.MkdirAll(*data, 0o700)
	ctx := context.Background()
	dbPath := filepath.Join(*data, "whatsapp.db")
	container, err := sqlstore.New(ctx, "sqlite", "file:"+filepath.ToSlash(dbPath)+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)", waLog.Noop)
	if err != nil {
		emit(map[string]any{"event": "error", "error": "couldn't open the sign-in store: " + err.Error()})
		os.Exit(1)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		emit(map[string]any{"event": "error", "error": err.Error()})
		os.Exit(1)
	}
	cli := whatsmeow.NewClient(device, waLog.Noop)

	cli.AddEventHandler(func(evt any) {
		switch v := evt.(type) {
		case *events.Message:
			text := textOf(v.Message)
			if text == "" || v.Info.Chat.Server == types.BroadcastServer {
				return
			}
			name := chatName(cli, v.Info.Chat, v.Info.PushName)
			from := name
			if v.Info.IsGroup {
				from = chatName(cli, v.Info.Sender, v.Info.PushName)
			}
			if v.Info.IsFromMe {
				from = "You"
			}
			m := msg{Chat: name, ChatID: v.Info.Chat.String(), From: from, Text: text, Time: v.Info.Timestamp.Unix(), Mine: v.Info.IsFromMe}
			remember(m)
			if !m.Mine && time.Since(v.Info.Timestamp) < 10*time.Minute {
				emit(map[string]any{"event": "message", "chat": m.Chat, "chatId": m.ChatID, "from": m.From, "text": m.Text, "time": m.Time})
			}
		case *events.Connected:
			me := ""
			if cli.Store.ID != nil {
				me = cli.Store.ID.User
			}
			emit(map[string]any{"event": "ready", "me": me})
		case *events.LoggedOut:
			emit(map[string]any{"event": "loggedOut"})
		}
	})

	if cli.Store.ID == nil {
		qrChan, _ := cli.GetQRChannel(ctx)
		if err := cli.Connect(); err != nil {
			emit(map[string]any{"event": "error", "error": "couldn't connect: " + err.Error()})
			os.Exit(1)
		}
		go func() {
			for item := range qrChan {
				switch item.Event {
				case "code":
					emit(map[string]any{"event": "qr", "png": qrPNG(item.Code)})
				case "timeout":
					emit(map[string]any{"event": "qrTimeout"})
				}
			}
		}()
	} else if err := cli.Connect(); err != nil {
		emit(map[string]any{"event": "error", "error": "couldn't connect: " + err.Error()})
	}

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 1<<20)
	for in.Scan() {
		var req struct {
			ID   string `json:"id"`
			Cmd  string `json:"cmd"`
			To   string `json:"to"`
			Text string `json:"text"`
			Chat string `json:"chat"`
			Max  int    `json:"max"`
		}
		if json.Unmarshal(in.Bytes(), &req) != nil {
			continue
		}
		go handle(cli, req.ID, req.Cmd, req.To, req.Text, req.Chat, req.Max)
	}
	cli.Disconnect() // BEV closed us
}

func handle(cli *whatsmeow.Client, id, cmd, to, text, chatQuery string, max int) {
	reply := func(data any, err error) {
		if err != nil {
			emit(map[string]any{"reply": id, "ok": false, "error": err.Error()})
			return
		}
		emit(map[string]any{"reply": id, "ok": true, "data": data})
	}
	switch cmd {
	case "send":
		if strings.TrimSpace(text) == "" {
			reply(nil, fmt.Errorf("there's nothing to send"))
			return
		}
		jid, err := toJID(cli, to)
		if err != nil {
			reply(nil, err)
			return
		}
		_, err = cli.SendMessage(context.Background(), jid, &waE2E.Message{Conversation: proto.String(text)})
		if err == nil {
			remember(msg{Chat: chatName(cli, jid, ""), ChatID: jid.String(), From: "You", Text: text, Time: time.Now().Unix(), Mine: true})
		}
		reply(map[string]any{"to": chatName(cli, jid, "")}, err)
	case "chats":
		histMu.Lock()
		list := make([]chat, 0, len(history))
		for cid, h := range history {
			last := h[len(h)-1]
			list = append(list, chat{Name: names[cid], ChatID: cid, Unread: unread[cid], Preview: last.Text, Time: last.Time})
		}
		histMu.Unlock()
		sort.Slice(list, func(i, j int) bool { return list[i].Time > list[j].Time })
		reply(list, nil)
	case "read":
		cid, ok := findChat(chatQuery)
		if !ok {
			reply(nil, fmt.Errorf("no messages from %q since BEV connected", chatQuery))
			return
		}
		if max <= 0 {
			max = 15
		}
		histMu.Lock()
		h := history[cid]
		if len(h) > max {
			h = h[len(h)-max:]
		}
		h = append([]msg(nil), h...)
		unread[cid] = 0
		histMu.Unlock()
		reply(h, nil)
	case "logout":
		reply(nil, cli.Logout(context.Background()))
	default:
		reply(nil, fmt.Errorf("unknown command %q", cmd))
	}
}
