import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import { getSocket } from '../api/socket';

interface Props {
  agentId: string;
  visible: boolean;
  /** If provided, show this as a hint and pre-fill in shell (e.g. claude --resume ...) */
  resumeCommand?: string;
}

/**
 * Lazy-mounted interactive PTY terminal.
 * Only renders xterm after the user first clicks the Terminal button (visible=true).
 */
export function TerminalView({ agentId, visible, resumeCommand }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const openedRef = useRef(false);
  const everVisibleRef = useRef(false);
  const initialCommandSentRef = useRef(false);

  if (visible) everVisibleRef.current = true;

  useEffect(() => {
    if (!everVisibleRef.current || !containerRef.current) return;
    if (termRef.current) return;

    const container = containerRef.current;
    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc',
      },
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    term.loadAddon(new CanvasAddon());
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const socket = getSocket();
    socket.emit('agent:join', agentId);

    // Helper to open (or re-open) a PTY
    const openPty = (withCommand?: string) => {
      openedRef.current = true;
      const dims = fit.proposeDimensions();
      socket.emit('terminal:open', {
        agentId,
        cols: dims?.cols || 120,
        rows: dims?.rows || 30,
        initialCommand: withCommand,
      });
    };

    // PTY output → xterm
    const onOutput = (data: { agentId: string; data: string }) => {
      if (data.agentId !== agentId) return;
      term.write(data.data);
    };
    socket.on('terminal:output', onOutput);

    // PTY exit → show message, user can reopen manually or it auto-reopens a plain shell
    const onExit = (data: { agentId: string; exitCode: number }) => {
      if (data.agentId !== agentId) return;
      openedRef.current = false;
      // Reset terminal (clears alternate screen buffer artifacts)
      term.write('\x1b[?1049l'); // switch back to main buffer
      term.clear();
      term.write(`\x1b[90m[process exited with code ${data.exitCode}]\x1b[0m\r\n`);
      term.write('\x1b[90mReopening shell...\x1b[0m\r\n\r\n');
      // Re-open a fresh PTY — plain shell only, no auto-command replay
      setTimeout(() => openPty(), 500);
    };
    socket.on('terminal:exit', onExit);

    // xterm input → PTY
    const inputDisposable = term.onData((data: string) => {
      socket.emit('terminal:input', { agentId, data });
    });

    // Resize → PTY
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      socket.emit('terminal:resize', { agentId, cols, rows });
    });

    const onWindowResize = () => {
      if (container.offsetHeight) {
        fit.fit();
      }
    };
    window.addEventListener('resize', onWindowResize);

    term.focus();

    // Open PTY after delay (ensure room join is processed)
    // Only send the resume command on the very first open — not on re-toggle or after exit
    const cmd = initialCommandSentRef.current ? undefined : resumeCommand;
    initialCommandSentRef.current = true;
    setTimeout(() => openPty(cmd), 200);

    return () => {
      socket.off('terminal:output', onOutput);
      socket.off('terminal:exit', onExit);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      window.removeEventListener('resize', onWindowResize);
      if (openedRef.current) {
        socket.emit('terminal:close', agentId);
        openedRef.current = false;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [visible, agentId]);

  // Re-fit and focus when toggling back to visible
  useEffect(() => {
    if (visible && termRef.current && fitRef.current) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="terminal-view"
      style={{ display: visible ? 'flex' : 'none' }}
    />
  );
}
