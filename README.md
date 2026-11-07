# 删除会话 (dsh-session-delete)

给 DeepSeek Harness 的会话右键菜单补上一个原厂没有的动作：**永久删除一个会话**。

原厂行为是「会话可以归档，但绝不删除」（见 `@deepseek-ai/dsh-client-ui-workspace` 的 README），
归档只是把行藏起来，日志、投影缓存、工作区记录里的会话 id 全都还在。这个插件补上真正的删除。

## 用法

在侧边栏任意会话行上右键 → **删除会话** → 确认框里点 **永久删除**。

菜单项排在「归档会话」之后，带分隔线和危险色。

## 一次删除会清掉什么

| 目标 | 位置 |
| --- | --- |
| 会话日志目录 | `<DSH home>/sessions/<project key>/<session id>/` |
| 投影缓存缩略图 | `<DSH home>/storages/session_projcache/sessions/<session id>.json` |
| 工作区记录里的 id | 每个 `workspace.json` 记录的 `sessionIds` |
| 归档 / 置顶列表 | `global.archivedSessionIds`、`global.pinnedSessionIds` |
| 运行时寄存的两份条目 | Host 的 `sessions` store 与 `agents` store |

最后一行是必需的，不是顺手清理。会话一旦被侧边栏打开过，`dsh-api-session-controller`
就把它 `resume` 进内存，而 `sessionQuery.listSessions()` 会把 `ctx.sessions.list()` 里的
活会话**无条件并进**结果（即使它的日志目录已经不在了）。只删文件会让它变成一个
「磁盘上没有、列表里还在」的幽灵：在侧边栏里落进「未分组」，再点删除就报
「找不到该会话的存储记录」。所以删除时必须先调 `detachEntered` 把它从两个 store 里摘掉，
顺序是先 Agent 后 Session（与 `dsh-agent-loop` 的 teardown 一致）。

工作区目录本身、以及目录里的任何文件都不会被碰。

## 拒绝删除的情况

- **会话正在跑一轮对话**（`agent.status === 'running'`）：写作句柄会继续往日志里追加。
  等它停下来再删。
- 会话 id 指向的目录名不符合 `session-<uuid>` / `<uuid>` 形状：直接中止，不做路径猜测。

「只是被侧边栏打开过一次」不算运行中——这类会话在轮次之间写作句柄是关闭的，可以正常删除。

## 未分组

「未分组」不是一条持久化记录，而是 UI 在渲染时把不属于任何工作区的会话临时归到一起的伪分组。
所以它没有可删的对象；要清空它，就在它下面逐个删会话（本插件对未分组里的会话同样有效）。

工作区本身的「删除工作区」是原厂自带功能（右键工作区行即可），不在本插件范围内。

## 实现要点

- Host 半 (`index.js`) 通过一条 `webServer` 前缀路由 `/session-delete/api` 暴露删除动作。
  会话目录不是自己按 `cwd` 反推的，而是从 `sessionPersistence.stat()` 返回的
  `location.path` 上溯两级——那条路径才是后端真正写入的位置。
- 浏览半 (`client.js`) 用 `contextMenus` 服务挂 `target: "session"`、`order: 700` 的菜单贡献，
  确认框注册在 `shell.overlay`；删除成功后先 `ctx.sessions.handleSessionRemoved(sessionId)`
  就地摘掉那一行，再 `ctx.sessions.refresh()` 与服务端对账。
- 原厂的请求围栏 `connection.requestRejection()` 只放行同 authority 的 http(s) Origin，
  而桌面壳把界面跑在 `dsh-app://app/`，围栏永远不会放行本插件自己的 POST。
  这里改用自定义头 `x-dsh-session-delete: 1` 作为围栏：跨站页面没有 preflight 就设不了自定义头，
  而本路由不返回任何 CORS 授权，preflight 会被直接拒绝。

## 安装

已在当前 profile（`desktop`）中以本地目录软链方式安装：

```
plugin_manager install_bundle  target = D:\B\DeepSeekWork\deepseek-all\dsh-session-delete
```

改了 `index.js` 后重启 Host 半（`plugin_manager set_plugin` 的 target 要用 loader entryId
`include:session-delete`，先 `enabled:false` 再 `enabled:true`）；改 `client.js` 后刷新页面。
