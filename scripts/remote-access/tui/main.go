// Package main is a Bubble Tea TUI wrapper around the Cloudflare quick-tunnel
// onboarding scripts.
//
// It shells out to either ../cloudflare.sh (Unix) or ../cloudflare.ps1
// (Windows or anywhere pwsh is preferred), parses the line-prefixed protocol
// the scripts emit:
//
//	STATUS: <step>
//	URL:    <trycloudflare URL>
//	PROMPT: <yes/no question>
//	DONE:   <ok|aborted|error>
//
// and renders stepwise progress. The TUI is opt-in polish — the scripts work
// perfectly well without it.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

type config struct {
	shell string // "auto" | "bash" | "pwsh"
}

func parseFlags() config {
	var c config
	flag.StringVar(&c.shell, "shell", "auto", "Which script to run: auto, bash, or pwsh")
	flag.Parse()
	return c
}

// resolveScript picks the script to run, honoring --shell.
//
// Returns argv ready for exec.Command, the resolved kind ("bash" / "pwsh"),
// and any error.
func resolveScript(c config) ([]string, string, error) {
	scriptDir, err := scriptDir()
	if err != nil {
		return nil, "", err
	}

	pick := c.shell
	if pick == "auto" {
		if runtime.GOOS == "windows" {
			pick = "pwsh"
		} else {
			pick = "bash"
		}
	}

	switch pick {
	case "bash":
		bash, err := exec.LookPath("bash")
		if err != nil {
			return nil, "", fmt.Errorf("bash not on PATH: %w", err)
		}
		return []string{bash, filepath.Join(scriptDir, "cloudflare.sh")}, "bash", nil
	case "pwsh":
		pwsh, err := exec.LookPath("pwsh")
		if err != nil {
			return nil, "", fmt.Errorf("pwsh not on PATH: %w", err)
		}
		return []string{pwsh, "-NoProfile", "-File", filepath.Join(scriptDir, "cloudflare.ps1")}, "pwsh", nil
	default:
		return nil, "", fmt.Errorf("--shell must be auto, bash, or pwsh (got: %s)", pick)
	}
}

func scriptDir() (string, error) {
	// We expect to be run from scripts/remote-access/tui — parent dir holds
	// cloudflare.sh / .ps1 / success.html.
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Clean(filepath.Join(cwd, "..")), nil
}

// ---------------------------------------------------------------------------
// Bubble Tea model
// ---------------------------------------------------------------------------

type stepEvent struct {
	kind string // "STATUS" | "URL" | "PROMPT" | "DONE" | "RAW" | "ERR"
	body string
}

type doneEvent struct {
	err error
}

type model struct {
	cmd          *exec.Cmd
	stdinWriter  io.WriteCloser
	statuses     []string
	url          string
	prompt       string
	answer       string
	awaitingY    bool
	finalResult  string // "ok" | "aborted" | "error" | ""
	err          error
	scriptKind   string
	width        int
}

func initialModel(cmd *exec.Cmd, stdin io.WriteCloser, kind string) model {
	return model{
		cmd:         cmd,
		stdinWriter: stdin,
		scriptKind:  kind,
	}
}

func (m model) Init() tea.Cmd {
	return nil
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil

	case tea.KeyMsg:
		if m.awaitingY {
			switch msg.String() {
			case "y", "Y":
				m.answer = "y"
				m.awaitingY = false
				_, _ = m.stdinWriter.Write([]byte("y\n"))
				return m, nil
			case "n", "N", "esc", "ctrl+c":
				m.answer = "n"
				m.awaitingY = false
				_, _ = m.stdinWriter.Write([]byte("n\n"))
				return m, nil
			}
			return m, nil
		}

		if msg.String() == "ctrl+c" || msg.String() == "q" {
			// Kill the subprocess so trap-cleanup runs in the script
			if m.cmd != nil && m.cmd.Process != nil {
				_ = m.cmd.Process.Signal(os.Interrupt)
			}
			return m, tea.Quit
		}

	case stepEvent:
		switch msg.kind {
		case "STATUS":
			m.statuses = append(m.statuses, msg.body)
		case "URL":
			m.url = msg.body
		case "PROMPT":
			m.prompt = msg.body
			m.awaitingY = true
		case "DONE":
			m.finalResult = msg.body
		case "ERR":
			m.err = fmt.Errorf("%s", msg.body)
		}
		return m, nil

	case doneEvent:
		m.err = msg.err
		return m, tea.Quit
	}

	return m, nil
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

var (
	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#34d399"))
	dimStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#94a3b8"))
	urlStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#60a5fa"))
	promptStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#facc15"))
	errStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#f87171"))
	okStyle     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#34d399"))
)

func (m model) View() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("Cloudflare quick-tunnel onboarding"))
	b.WriteString("  ")
	b.WriteString(dimStyle.Render("(" + m.scriptKind + ")"))
	b.WriteString("\n\n")

	for _, s := range m.statuses {
		b.WriteString("  ")
		b.WriteString(dimStyle.Render("• "))
		b.WriteString(s)
		b.WriteString("\n")
	}

	if m.url != "" {
		b.WriteString("\n  ")
		b.WriteString(urlStyle.Render("URL: " + m.url))
		b.WriteString("\n")
		b.WriteString("  ")
		b.WriteString(dimStyle.Render("Open that URL on your phone."))
		b.WriteString("\n")
	}

	if m.awaitingY {
		b.WriteString("\n  ")
		b.WriteString(promptStyle.Render(m.prompt))
		b.WriteString("  ")
		b.WriteString(dimStyle.Render("[press y/n]"))
		b.WriteString("\n")
	}

	switch m.finalResult {
	case "ok":
		b.WriteString("\n  ")
		b.WriteString(okStyle.Render("✓ round-trip confirmed"))
		b.WriteString("\n")
	case "aborted":
		b.WriteString("\n  ")
		b.WriteString(dimStyle.Render("• aborted — tunnel torn down"))
		b.WriteString("\n")
	case "error":
		b.WriteString("\n  ")
		b.WriteString(errStyle.Render("✗ script reported an error"))
		b.WriteString("\n")
	}

	if m.err != nil {
		b.WriteString("\n  ")
		b.WriteString(errStyle.Render("error: " + m.err.Error()))
		b.WriteString("\n")
	}

	if m.finalResult == "" && m.err == nil {
		b.WriteString("\n  ")
		b.WriteString(dimStyle.Render("(ctrl-c to abort)"))
		b.WriteString("\n")
	}

	return b.String()
}

// ---------------------------------------------------------------------------
// Wire the subprocess to tea.Program
// ---------------------------------------------------------------------------

func run() error {
	cfg := parseFlags()

	argv, kind, err := resolveScript(cfg)
	if err != nil {
		return err
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", argv[0], err)
	}

	p := tea.NewProgram(initialModel(cmd, stdin, kind))

	// Fan stdout lines into the Bubble Tea program as messages.
	go func() {
		scanner := bufio.NewScanner(stdout)
		// cloudflared can print very long lines; give it room.
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			ev := parseLine(line)
			p.Send(ev)
		}
	}()

	// Wait for the subprocess in a separate goroutine.
	go func() {
		err := cmd.Wait()
		p.Send(doneEvent{err: err})
	}()

	_, err = p.Run()
	return err
}

func parseLine(line string) stepEvent {
	switch {
	case strings.HasPrefix(line, "STATUS: "):
		return stepEvent{kind: "STATUS", body: strings.TrimPrefix(line, "STATUS: ")}
	case strings.HasPrefix(line, "URL: "):
		return stepEvent{kind: "URL", body: strings.TrimPrefix(line, "URL: ")}
	case strings.HasPrefix(line, "PROMPT: "):
		return stepEvent{kind: "PROMPT", body: strings.TrimPrefix(line, "PROMPT: ")}
	case strings.HasPrefix(line, "DONE: "):
		return stepEvent{kind: "DONE", body: strings.TrimPrefix(line, "DONE: ")}
	default:
		return stepEvent{kind: "RAW", body: line}
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "tui:", err)
		os.Exit(1)
	}
}
