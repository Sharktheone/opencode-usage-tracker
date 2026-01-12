# OpenCode Usage Tracker Plugin

A plugin for OpenCode that tracks token usage across sessions with SQLite storage, custom pricing support, and detailed analytics.

## Features

- Track input, output, cache read, and cache write tokens per message
- Cumulative totals that never decrease (even if OpenCode loses history)
- Custom pricing overrides per model (configured in `opencode.json`)
- Default pricing for popular models (Claude, GPT-5, Codex)
- SQLite storage with Bun's built-in driver
- Multi-machine support via machine ID
- Commands for viewing usage statistics
- Optional toast notifications

## Installation

### Option 1: Clone to .opencode directory

```bash
# Global installation (all projects)
git clone https://github.com/your-username/opencode-usage-tracker ~/.config/opencode/plugin/usage-tracker
cd ~/.config/opencode/plugin/usage-tracker && bun install

# Or project-local installation
git clone https://github.com/your-username/opencode-usage-tracker .opencode/plugin/usage-tracker
cd .opencode/plugin/usage-tracker && bun install
```

### Option 2: Copy files manually

1. Copy `usage-tracker.ts` to `.opencode/plugin/` (or `~/.config/opencode/plugin/`)
2. Copy `command/` folder to `.opencode/command/` (or `~/.config/opencode/command/`)
3. Add dependencies to `.opencode/package.json`:
   ```json
   {
     "dependencies": {
       "@opencode-ai/plugin": "latest"
     }
   }
   ```
4. Run `bun install` in the `.opencode` directory

### Option 3: Symlink (for development)

```bash
git clone https://github.com/your-username/opencode-usage-tracker ~/dev/opencode-usage-tracker
cd ~/dev/opencode-usage-tracker && bun install

# Symlink to global plugins
ln -s ~/dev/opencode-usage-tracker/usage-tracker.ts ~/.config/opencode/plugin/usage-tracker.ts
ln -s ~/dev/opencode-usage-tracker/command ~/.config/opencode/command/usage-tracker
```

After installation, restart OpenCode.

## Usage

### Commands

#### `/usage` - Current Session

```
/usage              # Compact view
/usage --full       # Detailed breakdown
```

**Compact output:**
```
Session: 283K tokens | $0.42 | 12 msgs | 23m
  claude-sonnet-4-5: 201K tk / $0.42
  gpt-4o: 81K tk / -
```

**Full output:**
```
Session Usage
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
claude-sonnet-4-5
  Input:       45,230 tk    $0.1357
  Output:      12,847 tk    $0.1927
  Cache Read: 128,450 tk    $0.0385
  Cache Write: 15,200 tk    $0.0570
  ─────────────────────────────────
  Subtotal:   201,727 tk    $0.4239
...
```

#### `/globalusage` - Aggregated Usage

```
/globalusage              # Today, this week, this month
/globalusage --full       # Verbose with model breakdown
/globalusage --year       # Include yearly summary
/globalusage --all        # Include all-time summary
/globalusage --model X    # Filter by model (fuzzy match)
```

**Compact output:**
```
Today:  525K tk | $1.01 | 4 sess
Week:   2.9M tk | $5.90 | 18 sess
Month:  8.2M tk | $17.32 | 47 sess
```

## Configuration

Add to your `opencode.json` (project or global `~/.config/opencode/opencode.json`):

```json
{
  "usage-tracker": {
    "enabled": true,
    "dbPath": "~/.config/opencode/token-usage.db",
    "machineId": null,
    
    "toast": {
      "enabled": false,
      "trigger": "messages",
      "messagesInterval": 5,
      "costThreshold": 0.10,
      "timeIntervalMinutes": 10
    },
    
    "pricing": {
      "anthropic/claude-sonnet-4-5": {
        "input": 3.00,
        "output": 15.00,
        "cacheRead": 0.30,
        "cacheWrite": 3.75
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `dbPath` | string | `~/.config/opencode/token-usage.db` | SQLite database path |
| `machineId` | string | `os.hostname()` | Machine identifier for multi-machine setups |
| `toast.enabled` | boolean | `false` | Show toast notifications |
| `toast.trigger` | string | `"messages"` | Trigger type: `"messages"`, `"cost"`, `"time"` |
| `toast.messagesInterval` | number | `5` | Show toast every N messages |
| `toast.costThreshold` | number | `0.10` | Show toast when cost exceeds threshold ($) |
| `toast.timeIntervalMinutes` | number | `10` | Show toast every N minutes |
| `pricing` | object | `{}` | Custom pricing overrides (per million tokens) |

## Default Pricing

Built-in pricing for popular models (per million tokens):

| Model | Input | Output | Cache Read | Cache Write |
|-------|-------|--------|------------|-------------|
| anthropic/claude-sonnet-4-5 | $3.00 | $15.00 | $0.30 | $3.75 |
| anthropic/claude-opus-4-5 | $15.00 | $75.00 | $1.50 | $18.75 |
| openai/gpt-5 | $5.00 | $15.00 | $2.50 | $5.00 |
| openai/gpt-5.1 | $2.00 | $8.00 | $1.00 | $2.00 |
| openai/gpt-5.2 | $2.00 | $8.00 | $1.00 | $2.00 |
| openai/gpt-5-mini | $0.30 | $1.20 | $0.15 | $0.30 |
| openai/codex-1 | $3.00 | $15.00 | $1.50 | $3.00 |

Custom pricing in config overrides these defaults.

## Database

Data is stored in SQLite at `~/.config/opencode/token-usage.db` (configurable).

### Schema

```sql
CREATE TABLE token_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  created_at TEXT NOT NULL,
  machine_id TEXT NOT NULL
);
```

### Querying Directly

```sql
-- Daily usage for heatmap visualization
SELECT 
  date(created_at) as day,
  SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as total_tokens,
  SUM(cost) as total_cost,
  COUNT(*) as message_count
FROM token_usage
WHERE created_at >= date('now', '-365 days')
GROUP BY date(created_at)
ORDER BY day;

-- Usage by model
SELECT 
  model,
  SUM(input_tokens) as input,
  SUM(output_tokens) as output,
  SUM(cache_read_tokens) as cache_read,
  SUM(cache_write_tokens) as cache_write,
  SUM(cost) as total_cost
FROM token_usage
GROUP BY model
ORDER BY total_cost DESC;
```

## Multi-Machine Support

- Each record includes a `machine_id` (defaults to hostname)
- Override via config: `"machineId": "my-laptop"`
- `/globalusage` shows data for the current machine only
- The database file can be synced via cloud storage (iCloud, Dropbox, etc.)

## Architecture

### Token Tracking Flow

1. Plugin subscribes to `message.updated` events
2. On assistant message completion, extract token data
3. Check if message_id already exists (deduplication)
4. Calculate cost: custom pricing > default pricing > OpenCode's cost
5. Insert record into SQLite
6. Update in-memory session totals
7. Optionally show toast notification

### Cost Calculation

```
cost = (input_tokens * pricing.input / 1_000_000)
     + (output_tokens * pricing.output / 1_000_000)
     + (cache_read_tokens * pricing.cacheRead / 1_000_000)
     + (cache_write_tokens * pricing.cacheWrite / 1_000_000)
```

## File Structure

```
opencode-usage-tracker/
├── usage-tracker.ts      # Main plugin file
├── command/
│   ├── usage.md          # /usage command
│   └── globalusage.md    # /globalusage command
├── package.json          # Dependencies
├── opencode.json         # Example config
└── README.md             # This file
```

## Future: Convex Integration

The plugin is designed to allow swapping SQLite for Convex for real-time multi-machine sync. This would enable:

1. Automatic sync across machines
2. Web dashboard for usage visualization
3. No manual database file syncing

## License

MIT
