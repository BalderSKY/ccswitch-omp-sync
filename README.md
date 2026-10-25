# ccswitch-omp-sync

把 [CC Switch](https://github.com/farion1231/cc-switch) 里的 provider 同步进 [oh-my-pi / omp](https://github.com/can1357/oh-my-pi) 的 `models.yml`。

CC Switch 管得舒服，omp 用不了；omp 的 `models.yml` 手写起来烦。这个工具把两头接上：**在 CC Switch 里加卡，几秒后 omp 就能选到。**

```
CC Switch 库  →  ccswitch-omp-sync  →  ~/.omp/agent/models.yml  →  omp
                （只读库，不写库）
```

## 为什么需要它

查过 CC Switch 的二进制（32.9 MB），`models.yml` / `.omp` / `oh-my-pi` 各命中 **0 次**——它根本不写 omp 配置。反过来 omp 也不读 CC Switch 的 SQLite。

两边都很好用，中间没有桥。

## 安装

需要 Node.js ≥ 22.5（用到内置 `node:sqlite`）。

```bash
git clone https://github.com/<you>/ccswitch-omp-sync.git
cd ccswitch-omp-sync
node src/cli.mjs --print-config   # 先确认路径探测对不对
node src/cli.mjs --dry-run        # 再看会改什么
```

没有依赖，不需要 `npm install`。

## 用法

```bash
ccswitch-omp-sync                 # 写入 models.yml
ccswitch-omp-sync --dry-run       # 只打印，不写
ccswitch-omp-sync --json          # 机器可读
ccswitch-omp-sync --print-config  # 排查路径问题
```

**失败会吵**：找不到数据库、找不到目标文件、一个分组都产不出来，都会打印原因并以非零状态退出。不会假装成功。

## 配置

按需创建 `~/.config/ccswitch-omp-sync/config.json`：

```json
{
	"hosts": ["sub.example.com", "api.example.com"],
	"fixedIds": { "5f06": "primary" },
	"crossHome": false
}
```

| 键 | 作用 | 默认 |
|---|---|---|
| `hosts` | codex 面卡的白名单（host 名）。空 = 全部导出 | `[]` |
| `fixedIds` | `{"<key前4位>": "<固定 id>"}`，用于稳定命名 | `{}` |
| `claudeCurrentOnly` | claude 面只导当前卡 | `true` |
| `proxyBase` | claude 面本地代理地址 | `http://127.0.0.1:15721` |
| `crossHome` | 同时写 WSL 另一侧的 omp 配置 | `false` |
| `nonChatPattern` | 过滤非对话模型的正则 | `embedding\|diffusion\|image\|dall-e` |
| `defaultContextWindow` | 生成的 `contextWindow` | `1000000` |
| `defaultMaxTokens` | 生成的 `maxTokens` | `128000` |

对应环境变量：`CCSYNC_HOSTS`、`CCSYNC_FIXED_IDS`、`CCSYNC_DB`、`CCSYNC_TARGETS`、`CCSYNC_CROSS_HOME`、`CCSYNC_WIN_HOME` 等；也可用 `--config <path>` 指定配置文件。

### 分组命名

| 面 | 规则 |
|---|---|
| codex | `ccs-<key 前 4 位十六进制>`，例如 `sk-abcd…` → `ccs-abcd` |
| claude | 固定为 `cc-switch`（走本地代理，见下） |

`fixedIds` 可以把某个 tag 改成固定名。典型场景：omp 的 `config.yml` 里 `modelRoles` 已经引用了某个 provider 名，改名会让引用失效。

## 自动同步

工具本身只跑一次。要「加卡即生效」，用 systemd user timer 或 cron 定时跑：

```ini
# ~/.config/systemd/user/ccswitch-omp-sync.timer
[Unit]
Description=Sync CC Switch providers into omp

[Timer]
OnBootSec=10s
OnUnitActiveSec=5s

[Install]
WantedBy=timers.target
```

```ini
# ~/.config/systemd/user/ccswitch-omp-sync.service
[Unit]
Description=Sync CC Switch providers into omp

[Service]
Type=oneshot
ExecStart=/usr/bin/node %h/code/ccswitch-omp-sync/src/cli.mjs
```

```bash
systemctl --user enable --now ccswitch-omp-sync.timer
```

实际耗时约 1–3 秒（主要是联网探模型列表）。

## 设计取舍

### 只读库，绝不写库

早期版本走过一条弯路：先把 codex 卡「镜像」成 `app_type='pi'` 的行写回库，再转换。放弃的原因是 **CC Switch 不监听数据库变化**：

- 二进制里 `watch` / `notify` 的命中全部来自 HTTP 库，没有文件 watcher
- 实测：GUI 启动 09:03，外部写库 11:02，库里 9 行而 GUI 只显示 3 行

写进去的行在 GUI 重启前不显示。用户打开对应面板看到的是自己加的几张卡，会以为同步没生效。中间层唯一的价值（在 GUI 里核对 omp 用什么）不成立，那就该删掉。

### 只改自己认领的块

`models.yml` 里除了 `providers:` 还有你手写的东西：

```yaml
providers:
  my-manual:      # ← 手工分组，保留
    ...
  ccs-abcd:       # ← 本工具生成，重建
    ...
modelRoles:       # ← 段外内容，一字不动
  default: my-manual/some-model
```

整段替换会静默删掉手工分组（早期版本踩过）。所以只切「本次产出的 id ∪ 历史命名」，其余原样保留。

### 探针抖动时取并集

上游 `/v1/models` 会瞬时不稳：实测同一张卡一次返回 11 个模型、下一次超时退回卡里的 `model = "..."` 只剩 1 个。若直接覆盖，用户的选择器会凭空少一堆模型。

策略：新结果比上次少时取**并集**。代价是模型下架时旧条目多留一轮，比「凭空消失」温和得多，下一轮稳定后自然收敛。

### claude 面只导当前卡

CC Switch 的本地代理（默认 `127.0.0.1:15721`）按「当前选中的卡」注入 key，**不认请求里传的 key**。所以把其他 claude 卡也导出来，只会得到几个打同一张卡的重复分组。

## 已知限制

**依赖 CC Switch 的私有 schema，没有版本契约。**

用到的结构：

```
providers(id, app_type, name, settings_config, is_current, ...)
settings_config (codex)  = { auth: { OPENAI_API_KEY }, config: "<TOML>" }
settings_config (claude) = { env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN } }
```

这些都不是公开 API。上游改字段的话，本工具会：

1. 启动时 `PRAGMA table_info(providers)` 检查必需列，缺了就明确报错
2. 单张卡解析失败时列出**具体原因**（缺哪个字段），而不是静默跳过

但仍可能出现「上游改了嵌套结构、列名没变」的情况。遇到时看 `--json` 输出里的 `skipped` 原因。

测试对应用例在 `test/sync.test.mjs`，改 schema 后跑 `npm test` 会立刻暴露逻辑回归。

## 与同类项目的区别

GitHub 上已有的尝试（`omp-cc-switch`、`omp-switch`）都试图做一个完整的 GUI 或改动 CC Switch 的数据。这个工具反过来：**不造 GUI、不写别人的库**，只做一件单向的事，并且把踩过的坑写进代码注释。

## License

MIT
