(() => {
  const now = Date.now();
  const resetsIn = (hours) => new Date(now + hours * 60 * 60 * 1000).toISOString();

  data = {
    generated_at: new Date(now).toISOString(),
    sections: [
      {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        stale_ms: 0,
        limits: [
          { label: '5-hour', percent: 22, resets_at: resetsIn(2), window_hours: 5 },
          { label: 'Weekly, all models', percent: 54, resets_at: resetsIn(72), window_hours: 168 },
          { label: 'Weekly, Fable', percent: 68, resets_at: resetsIn(72), window_hours: 168 },
        ],
      },
      {
        id: 'codex',
        name: 'Codex',
        plan: 'Pro',
        installed: true,
        stale_ms: 0,
        limits: [
          { label: 'Weekly', percent: 31, resets_at: resetsIn(106), window_hours: 168 },
        ],
      },
    ],
  };
  lastOk = Date.now();
  lastFullHtml = null;
  lastStripHtml = null;
  render();
  return { sections: data.sections.length };
})()
