DSH Confluence 插件（dsh-plugin-confluence）
================================================================================

把 Atlassian Confluence 接进 DeepSeek Harness（DSH）的插件包：29 个类型化
confluence_* 工具、一个 confluence 技能（skill），以及一个用来配置连接与写权限
的设置页。

一次调用 = 在子进程里执行 confluence-cli。认证、限流、Markdown 与 storage 互转、
JSON 输出都沿用 CLI 的行为，插件本身不重复实现 Confluence API。

仓库地址：https://github.com/liujia1128/dsh-confluence
许可证：MIT


一、功能概览
--------------------------------------------------------------------------------

1) 读工具（13 个，始终可用）

   confluence_read             读取页面正文（text / markdown / storage / html）
   confluence_info             页面元数据（id、标题、空间、版本、祖先）
   confluence_find             按标题精确查找页面
   confluence_search           全文搜索，或直接以 cql=true 执行 CQL
   confluence_spaces           列出空间
   confluence_children         列出/树形展开子页面与子文件夹
   confluence_export           把页面导出为工作区文件（可 dryRun、可递归）
   confluence_convert          在 markdown / storage / html / text 之间转换
   confluence_versions         查看版本历史
   confluence_comments         列出评论（footer 或 inline，可展开回复）
   confluence_attachments      列出附件，或下载到工作区
   confluence_property_list    列出内容属性
   confluence_property_get     按 key 读取单个内容属性

2) 写工具（16 个，仅在启用并配置了允许空间后注册）

   confluence_create                   在空间下新建页面或文件夹
   confluence_create_child             在指定父页面下新建
   confluence_update                   更新标题和/或正文（生成新版本）
   confluence_move                     移动到新父页面，可顺带改名
   confluence_delete                   删除页面（不可逆）
   confluence_comment_create           添加评论（footer 或 inline 锚定）
   confluence_comment_delete           删除评论
   confluence_property_set             新建或更新内容属性
   confluence_property_delete          删除内容属性
   confluence_attachment_upload        上传一个或多个工作区文件
   confluence_attachment_delete        删除附件
   confluence_version_delete           删除某个历史版本
   confluence_copy_tree_preview        预览子树复制，返回一次性 approvalId
   confluence_copy_tree                执行子树复制（只接受该 approvalId）
   confluence_versions_purge_preview   预览历史版本清理
   confluence_versions_purge           执行历史版本清理

3) 技能

   激活时通过 ctx.skills 注册名为 confluence 的技能，内容是面向工具的用法说明：
   格式选择、写入纪律、批量两步走、本地文件边界、错误码对照表。只读 profile 下
   技能描述会自动注明「未注册写工具」。

4) 设置页

   位置：设置 → Confluence（settings.section，id=confluence，顺序 26，带独立导航图标）
   详见下方「四、设置页」。


二、环境要求
--------------------------------------------------------------------------------

   * DeepSeek Harness 0.2.2（含 profile 的桌面版或 Web 版）
   * Node.js 20 或更高版本
   * 一份 confluence-cli（见「五、插件用哪一份 confluence-cli」）
   * Confluence 凭据，四种来源任选其一：
       - 环境变量 CONFLUENCE_*
       - 执行过 confluence init 生成的配置文件
       - macOS Keychain
       - ~/.netrc


三、安装
--------------------------------------------------------------------------------

方式 A：直接按仓库地址安装（推荐）

   在 DSH 中打开「插件 → 添加插件」，填入：

       https://github.com/liujia1128/dsh-confluence

   或者在会话里用 plugin_manager 工具，action=install_bundle，target 填上面这个地址。

方式 B：本地克隆（开发或需要固定版本时）

       git clone https://github.com/liujia1128/dsh-confluence
       cd dsh-confluence
       npm install

   然后把该目录作为插件添加。本地目录安装是链接方式，改动后重载插件即生效。

说明：插件不会自己保存任何凭据；装完还要按「四、设置页」或「五、YAML 配置」
填站点与 token，否则调用会返回 CLI 的「未找到配置」错误。

方式 C：离线 / 内网机器（装不了依赖的机器）

   运行时依赖已经提交在仓库里（deps/node_modules.tar.gz，107 个生产依赖、无原生
   二进制），不需要 npm：

       node scripts/install-offline.mjs

   它会先核对 deps/node_modules.sha256，再解压出 node_modules/。之后把「这个目录」
   作为插件添加（本地目录方式）；离线机器不要用 git 地址添加，那条路径会跑包安装、
   需要联网。

   改了依赖之后，在联网机器上执行 npm run deps:pack 重建归档与校验和，两个文件
   一起提交。细节见 deps/README.md。


四、设置页
--------------------------------------------------------------------------------

打开「设置 → Confluence」，页面上有三组内容：

   站点与认证
       站点地址            例如 https://company.atlassian.net/wiki
       主机名（可选）      例如 company.atlassian.net；与站点地址二选一
       API 基路径          Cloud 用 /wiki/rest/api，Server/DC 用 /rest/api
       认证方式            basic（邮箱 + API token）或 bearer（DC personal token）
       登录邮箱            basic 认证必填
       CLI 配置名          对应 confluence-cli 的命名 profile，可留空
       API token           密码框；只回显「已保存 / 未设置」，可一键清除

   写入权限
       注册写工具          开关；关闭时只有 13 个只读工具
       允许的空间 key      逗号或空格分隔，不支持通配符；为空等于关闭写工具
       审批方式            ask（每次写都请求审批）或 never（跳过审批）

   当前运行状态
       已注册工具数、允许空间、审批方式、CLI 目录

行为要点：

   * 保存 = 写本 profile 的 cordis.patch.yml 中 confluence 那一行（通过 configEditor
     完成），随后 loader 立即重建插件，所以工具集合当场变化，不需要重启。
   * 页面清空的文本框会从那一行里删除，而不是写入空字符串。
   * 「测试连接」真实执行一次 spaces --limit 1，成功显示空间数，失败显示 CLI 原始
     错误（例如域名写错、token 失效），便于在正式调用前发现问题。
   * token 存在那一行里，页面只回显是否存在；不想落盘就改用环境变量
     CONFLUENCE_API_TOKEN。
   * 页面与 Host 之间走三条同源路由：/dsh-confluence/state、/save、/test。每条都要求
     页面自带的 x-dsh-confluence 请求头 + 本机（loopback）Host；带 Origin 时必须同源，
     因此别的网站无法驱动这些接口。


五、YAML 配置（与设置页等价）
--------------------------------------------------------------------------------

在 profile 自己的 patch 层覆盖该行。注意：同名覆盖会替换整个 config，所以要把还想
保留的键一起写上。

   - id: confluence
     name: dsh-plugin-confluence
     config:
       writes: true
       spaces: [ENG, DOCS]
       confirm: ask
       confluence:
         domain: company.atlassian.net
         apiPath: /wiki/rest/api
         authType: basic
         email: you@company.com
       env:
         CONFLUENCE_API_TOKEN: !!js process.env.CONFLUENCE_API_TOKEN

配置键说明：

   siteUrl / domain     站点地址或主机名，二选一
   apiPath              REST 基路径，Cloud: /wiki/rest/api，Server/DC: /rest/api
   authType             basic | bearer（默认 basic）
   email / username     basic 认证的身份
   token                API token；留空则回落到环境变量、Keychain、~/.netrc
   profile              confluence-cli 命名 profile
   writes               是否注册写工具（默认 false）
   spaces               允许写入的空间 key 列表，不支持通配符，为空即关闭写工具
   confirm              ask | never（默认 ask）
   preflightTtlMs       批量操作 approvalId 的有效期，默认 300000 毫秒
   packageRoot          指定某一份 confluence-cli 目录（覆盖下面的解析顺序）
   nodePath             执行 CLI 使用的 Node 可执行文件，默认用 DSH 的运行时
   skill                是否注册 confluence 技能（默认 true）

环境变量 CONFLUENCE_READ_ONLY=true 始终优先：写工具不会注册。


六、插件用哪一份 confluence-cli
--------------------------------------------------------------------------------

按顺序取第一个命中项：

   1. 插件行上的 packageRoot
   2. 环境变量 CONFLUENCE_CLI_ROOT
   3. 包围本插件的上层目录（… 两次），即上游仓库的开发布局
   4. 本包声明的依赖 confluence-cli

一个都不命中时，插件激活即失败并给出提示，不会悄悄换用别的副本。


七、写权限与审批
--------------------------------------------------------------------------------

   1. 写工具只在「显式开启 + 非空允许空间列表」同时成立时注册。
   2. 每次普通写操作依次执行：本地 preflight（解析真实标题、id、空间）→ 校验允许空间
      → 通过 ctx.approval 请求一次性审批 → 重新校验文件快照 → 执行 CLI。
      审批理由就是 preflight 摘要（例如「Update Target (42) in ENG」），人能直接判断。
   3. 批量写是两步：preview 解析出将被影响的全部页面并返回一次性 approvalId；
      execute 只接受这个 id，会重跑 preflight，计划变了就用 STALE_PREFLIGHT 拒绝。
      id 一次性、默认 5 分钟过期。
   4. 写操作涉及的本地文件（正文、属性、附件）在审批前做哈希，审批后重新校验，
      期间被改动会以 STALE_FILE 中止。
   5. 超时或被中断的写操作返回 UNKNOWN_RESULT，插件不会自动重试。
   6. 所有从 Confluence 取回的内容都按不可信外部内容处理，工具结果带有明确标注。


八、错误码速查
--------------------------------------------------------------------------------

   INVALID_ARGUMENTS                    参数缺失、未知或类型不对，消息会逐条列出
   INVALID_ARGUMENT                     正文/路径值未通过写入校验
   CLI_FAILED                           CLI 退出码非 0（认证、404、403、限流等）
   UNKNOWN_RESULT                       写操作结果未知：先重读目标，再决定是否重试
   SPACE_NOT_ALLOWED                    目标空间不在允许列表内，停止并告知用户
   SPACE_NOT_RESOLVED                   preflight 无法确认目标空间
   STALE_PREFLIGHT / STALE_FILE         计划或本地文件在审批后变化，需重新走流程
   UNKNOWN_APPROVAL / EXPIRED_APPROVAL  批量 approvalId 已用过或已过期
   APPROVAL_OPERATION_MISMATCH          approvalId 属于另一个批量操作
   PAYLOAD_INVALID / PAYLOAD_TOO_LARGE  正文、属性或附件超过限制
   APPROVAL_REJECTED / _CANCELLED / _UNAVAILABLE
                                        未获得审批，什么也没写入
   PROJECT_PATH                         路径越出当前会话工作目录


九、开发与测试
--------------------------------------------------------------------------------

       npm install
       npm test

   测试覆盖：配置解析、工具面、参数校验、读/写/批量执行、审批接线、设置页路由、
   客户端模块契约、离线依赖归档，共 66 项。CI 在 Node 20 / 22 / 24 上跑
   npm ci + npm test。

   改了依赖后重建离线归档（需要联网）：npm run deps:pack

目录结构：

   index.js              ESM 入口：apply、inject、插件名、Config schema
   lib/plugin.cjs        组装配置、引擎、工具、审批、技能与设置页路由
   lib/engine.cjs        解析 confluence-cli 并加载其 lib/pi/* 引擎
   lib/config.cjs        行配置 + 环境变量 → CLI 环境与写入策略
   lib/tools.cjs         工具定义、schema 与逐次执行
   lib/args.cjs          按声明 schema 子集做参数校验
   lib/settings-route.cjs 设置页的三条路由：state、save、test
   client/client.js      设置页与导航图标（浏览器端模块）
   SKILL.md              激活时注册的 confluence 技能正文
   docs/DETAIL.md        插件管理页展示的详细说明
   locale/、icon.svg     插件管理页显示元数据
   tests/plugin.test.js  测试


十、常见问题
--------------------------------------------------------------------------------

   Q: 工具调用报「No configuration found!」
   A: 凭据没配好。去「设置 → Confluence」填站点与 token，或设置 CONFLUENCE_* 环境
      变量后点「测试连接」。

   Q: 看不到写工具
   A: 写工具是激活期决定的：需要 writes 打开且 spaces 非空。保存后插件会立即重建，
      若仍看不到，检查 CONFLUENCE_READ_ONLY 是否为 true。

   Q: 提示找不到 confluence-cli
   A: 在克隆下来的插件目录里执行 npm install（它会装上声明的依赖），或用
      CONFLUENCE_CLI_ROOT / packageRoot 指向一份可用的 confluence-cli。

   Q: 写操作返回 UNKNOWN_RESULT 怎么办
   A: 不要当作失败直接重试。先用 confluence_info / confluence_read 重读目标，确认是否
      已经写入，再决定下一步。


许可证
--------------------------------------------------------------------------------

MIT，详见 LICENSE。
