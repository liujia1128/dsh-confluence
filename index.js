/**
 * Host half of the DeepSeek Harness Confluence bundle.
 *
 * Registers typed `confluence_*` tools, a `confluence` skill, and the Host
 * routes behind the Confluence settings page. Every tool call is executed by
 * this checkout's confluence-cli engine in a child process, so the CLI stays
 * the single source of truth for authentication, rate limiting, conversion,
 * and JSON envelopes.
 *
 * `tools` and `connection` are hard dependencies; `approval`, `skills`,
 * `workingDirectory`, `settings`, and `webServer` are consumed opportunistically
 * so the bundle still activates in profiles that compose fewer of them.
 * `connection` gates the settings routes behind the composition's own
 * Host/Origin fence and browser authentication (`requestRejection`), the same
 * trust surface every shipped route runs behind.
 */
import z from '@deepseek-ai/schemastery';
import plugin from './lib/plugin.cjs';

export const name = 'confluence';
export const inject = ['tools', 'connection'];

/**
 * The settings page's editable fields. Declaring the schema gives the plugin a
 * settings namespace, so values saved from the page layer over the patch entry
 * and reach `apply` as `config`.
 */
export const Config = z.object({
  siteUrl: z.string().description('站点地址，例如 https://company.atlassian.net/wiki（与 domain 二选一）'),
  domain: z.string().description('仅主机名，例如 company.atlassian.net 或 confluence.example.com'),
  apiPath: z.string().description('REST 基路径：Cloud 用 /wiki/rest/api，Server/DC 用 /rest/api'),
  authType: z.union([z.const('basic'), z.const('bearer')]).default('basic')
    .description('basic 用邮箱 + API token；bearer 用 Data Center personal access token'),
  email: z.string().description('basic 认证的登录邮箱'),
  username: z.string().description('旧式用户名（可选）'),
  token: z.string().role('secret').description('API token / personal access token；留空则回落到环境变量、Keychain 或 ~/.netrc'),
  profile: z.string().description('confluence-cli 命名配置（可选）'),
  writes: z.boolean().default(false).description('是否注册写工具；还需要至少一个允许的空间'),
  spaces: z.array(z.string()).description('允许写入的空间 key 列表，例如 ENG、DOCS'),
  confirm: z.union([z.const('ask'), z.const('never')]).default('ask')
    .description('ask 每次写操作都请求审批；never 跳过审批'),
  preflightTtlMs: z.number().min(60000).default(300000).description('批量操作审批 id 的有效期（毫秒）'),
  packageRoot: z.string().description('confluence-cli 检出目录（默认本 bundle 的上级目录）'),
  nodePath: z.string().description('执行 CLI 的 Node 可执行文件（默认 DSH 的运行时）'),
  skill: z.boolean().default(true).description('是否注册 confluence skill'),
});

export function apply(ctx, config) {
  return plugin.apply(ctx, config);
}
