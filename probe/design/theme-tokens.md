# DSH 真实主题令牌（查证结果）

来源：`D:\Hima\App\Deepseek\resources\app.asar` 内
`dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`（令牌定义）
与 `dsh-client-ui-primitives/lib/*.module.css`（用法）。
用 `probe/asar-grep.mjs` 按**匹配**而非按行提取——产物是压缩过的单行。

## 结论一：插件里那组 `--dsh-*` 变量根本不存在

全仓库搜索 `--dsh-surface-raised` / `--dsh-border` / `--dsh-accent`，
只命中 `dsh-voice-chat/client.js:695` 自己。DSH 的主题变量前缀是 **`--dsw-`**。
所以设置面板那句

```js
background: 'var(--dsh-surface-raised, #1b1b1f)'
```

永远走 `#1b1b1f` 深色兜底，而文字是 `color: 'inherit'`——在亮色主题下就是**深字压深底**。
这就是"文字与面板同色、看不清"的根因。
（`#1b1b1c` 实际是 `--dsw-static-neutral-bluish-900`，推测是上一会话从暗色主题里抄来的。）

## 结论二：暗色开关

`body[data-ds-dark-theme]`。亮色令牌挂在 `body`，暗色覆盖挂在该属性选择器下。
插件的注入样式表应当沿用同一选择器，才能跟着 DSH 主题走。

## 结论三：DSH 自己的浮层配方（`MenuSurface`）

```css
background: var(--dsw-menu-surface-fill);
backdrop-filter: var(--dsw-menu-backdrop-filter);   /* blur(40px) saturate(150%) */
border-radius: var(--dsw-radius-lg);
box-shadow: var(--dsw-elevation-prominent);
color: var(--dsw-alias-label-primary);
```

## 令牌表（亮 → 暗）

| 令牌 | 亮色 | 暗色 |
|---|---|---|
| `--dsw-alias-label-primary` | `#0f1115` (bluish-1000) | `#f9fafb` (bluish-50) |
| `--dsw-alias-label-secondary` | `#61666b` (bluish-700) | `#cfd3d6` (bluish-300) |
| `--dsw-alias-label-tertiary` | `#81858c` (bluish-600) | `#adb2b8` (bluish-400) |
| `--dsw-alias-label-primary-foreground` | `#ffffff` | `#0f1115` |
| `--dsw-alias-bg-base` | `#ffffff` | `#151517` (bluish-950) |
| `--dsw-alias-bg-layer-1` | `#ffffff` | `#232324` (bluish-875) |
| `--dsw-alias-bg-layer-2` | `#ffffff` | `#2c2c2e` (bluish-850) |
| `--dsw-alias-bg-layer-3` | `#ffffff` | `#353638` (bluish-800) |
| `--dsw-menu-surface-fill` | `#f8f9fa94` | `#43454a73` |
| `--dsw-alias-border-l1` | `#0000000a` | `#ffffff0f` |
| `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` |
| `--dsw-alias-border-l3` | `#0000001f` | `#ffffff29` |
| `--dsw-alias-border-l4` | `#00000029` | `#ffffff33` |
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` |
| `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` |
| `--dsw-alias-state-business-primary` | `#4176e6` (deepseek-500) | `#7aaaff` (deepseek-400) |
| `--dsw-alias-state-success-primary` | `#22c55e` (green-500) | `#4ed17e` (green-400) |
| `--dsw-alias-state-warn-primary` | `#f59e0b` (amber-500) | `#f7ad31` (amber-400) |
| `--dsw-alias-state-error-primary` | `#ec1313` (red-600) | `#f25a5a` (red-400) |
| `--dsw-radius-sm / md / lg / xl / panel` | `8 / 12 / 16 / 20 / 28px` | 同 |

阴影：`--dsw-elevation-panel`、`--dsw-elevation-prominent`、`--dsw-elevation-soft`
（都由 `--dsw-elevation-stroke` = `0 0 0 .5px <stroke color>` 加两层柔和投影组成）。

控件参考：`Input` 外框 `0.5px solid var(--dsw-alias-border-l4)` + `--dsw-alias-bg-layer-1` + `--dsw-radius-md`，
聚焦时描边转 `--dsw-alias-state-business-primary`；`Button` 圆角 `--dsw-radius-md`，`sm` 高 28 / 字号 12。
