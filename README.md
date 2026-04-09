# LatentInfo

A misc app for passively collecting and processing info from Chrome (version 144+).

## Feature

###  Collectors

| Collector | What it collects |
|-----------|-----------------|
| x | Tweet content, media, thread structure |
| arxiv | Paper metadata (title, authors, abstract, categories) |
| web_clipper | Auto-detected article clips with HTML + markdown |

### Jobs

| Job | What it does |
|-----|-------------|
| x_tag | Tags tweets using a local LLM endpoint |
| arxiv_dl | Downloads PDF, TeX source, generates markdown |
| web_clip_markdown | Converts clipped HTML to clean markdown |

## Development

- Node.js >= 18
- pnpm 9+

```sh
# Full GUI mode (Electron + Vite + backend)
pnpm dev:all
```

## Data

Data and settings are stored in `~/.latent_info/`.

## Credit

- [OpenCLI](https://github.com/jackwener/OpenCLI)
- [Defuddle](https://github.com/kepano/defuddle)
- [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper)
