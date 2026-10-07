# RecallMap

RecallMap estimates recall probability with an Ebbinghaus exponential decay model and turns an Obsidian vault into an interactive memory-health dashboard.

## Current MVP

- Colorful memory-health dashboard
- Clickable status cards that open the contributing notes
- Ebbinghaus recall estimate
- Per-note review-time estimate
- Default complexity plus manual per-note override
- Live settings example showing how complexity changes time
- Review action that reinforces stability

## Development

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/recallmap/`.
