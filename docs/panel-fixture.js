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
          { label: '5-hour', percent: 33, resets_at: resetsIn(2.9), window_hours: 5 },
          { label: 'Weekly, all models', percent: 36, resets_at: resetsIn(74), window_hours: 168 },
          { label: 'Weekly, Fable', percent: 53, resets_at: resetsIn(74), window_hours: 168 },
        ],
      },
      {
        id: 'codex',
        name: 'Codex',
        installed: true,
        stale_ms: 0,
        limits: [
          { label: 'Weekly', percent: 32, resets_at: resetsIn(116), window_hours: 168 },
        ],
      },
      {
        id: 'gemini',
        name: 'Gemini',
        installed: true,
        stale_ms: 0,
        limits: [
          { label: '5-hour', percent: 24, resets_at: resetsIn(1.9), window_hours: 5 },
          { label: 'Weekly', percent: 6, resets_at: resetsIn(149), window_hours: 168 },
        ],
      },
    ],
  };
  lastOk = Date.now();
  lastFullStructure = null;
  lastStripHtml = null;
  render();
  return { sections: data.sections.length };
})()
