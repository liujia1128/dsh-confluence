/**
 * dsh-plugin-confluence — client half.
 *
 * One page in the Settings panel that edits this plugin's own configuration:
 * the Confluence site and credentials, the write policy, and the approval mode.
 * Values are read from and written to the Host over three same-origin routes
 * (`dsh/lib/settings-route.cjs`), which persist them in the settings document's
 * user section — so a saved value layers over the profile patch instead of
 * rewriting it, and the tools pick it up when the plugin re-applies.
 *
 * The bundle follows the official client-modules contract:
 *   window.__ModuleLoader__.load({ id, factory })
 * Its only external is `react` from the loader's module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-confluence',
  factory: (require) => {
    const { createElement: h, useCallback, useEffect, useRef, useState } = require('react');

    const BASE = '/dsh-confluence';
    const HEADERS = { 'x-dsh-confluence': '1' };
    const AUTH_TYPES = ['basic', 'bearer'];
    const CONFIRM_MODES = ['ask', 'never'];

    /** The interface language decides the page language, as it does for the shell. */
    function detectZh() {
      const tag = typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang : '';
      if (/^zh(-|$)/i.test(tag)) return true;
      if (tag !== '' && !/^en(-|$)/i.test(tag)) return false;
      const first = typeof navigator !== 'undefined' && Array.isArray(navigator.languages) ? navigator.languages[0] : '';
      return typeof first === 'string' && /^zh(-|$)/i.test(first);
    }

    const zh = detectZh();
    const t = (zhText, enText) => (zh ? zhText : enText);

    const styles = {
      page: { maxWidth: 620, padding: '4px 2px 24px' },
      intro: {
        margin: '0 0 18px', fontSize: 13, lineHeight: 1.7,
        color: 'var(--dsw-alias-label-secondary)',
      },
      group: {
        marginBottom: 20, padding: '16px 18px', borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      groupTitle: {
        margin: '0 0 4px', fontSize: 13, fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      groupHint: {
        margin: '0 0 12px', fontSize: 12, lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
      },
      field: { marginBottom: 12 },
      label: {
        display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6,
        color: 'var(--dsw-alias-label-primary)',
      },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '8px 10px',
        borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        fontSize: 13, outline: 'none',
      },
      pair: { display: 'flex', gap: 12, alignItems: 'flex-start' },
      hint: {
        margin: '6px 0 0', fontSize: 12, lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary)',
      },
      switchRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, marginBottom: 12,
      },
      switch: (on) => ({
        position: 'relative', width: 40, height: 22, flex: '0 0 auto',
        borderRadius: 999, cursor: 'pointer', border: 'none', padding: 0,
        background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-idle-primary)',
        transition: 'background 120ms ease',
      }),
      knob: (on) => ({
        position: 'absolute', top: 3, left: on ? 21 : 3, width: 16, height: 16,
        borderRadius: '50%', background: '#fff', transition: 'left 120ms ease',
      }),
      actions: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      primary: {
        padding: '8px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)', color: '#fff',
      },
      secondary: {
        padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
      },
      status: (kind) => ({
        marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: kind === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : kind === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : kind === 'ok'
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-label-secondary)',
      }),
      meta: {
        display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px',
        fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)',
      },
      badge: (on) => ({
        display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 11,
        border: '1px solid var(--dsw-alias-border-l1)',
        color: on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
    };

    const FIELDS = [
      'siteUrl', 'domain', 'apiPath', 'authType', 'email', 'username',
      'profile', 'writes', 'spaces', 'confirm',
    ];

    function blankForm() {
      return {
        siteUrl: '', domain: '', apiPath: '', authType: 'basic', email: '', username: '',
        profile: '', writes: false, spaces: '', confirm: 'ask',
      };
    }

    function formFromState(state) {
      const stored = state && typeof state.stored === 'object' && state.stored !== null ? state.stored : {};
      const form = blankForm();
      for (const key of ['siteUrl', 'domain', 'apiPath', 'email', 'username', 'profile']) {
        if (typeof stored[key] === 'string') form[key] = stored[key];
      }
      if (AUTH_TYPES.includes(stored.authType)) form.authType = stored.authType;
      if (CONFIRM_MODES.includes(stored.confirm)) form.confirm = stored.confirm;
      form.writes = stored.writes === true;
      if (Array.isArray(stored.spaces)) form.spaces = stored.spaces.join(', ');
      return form;
    }

    /** The patch the save route accepts: every editable field, spaces as a list. */
    function patchFromForm(form) {
      const patch = {};
      for (const key of FIELDS) {
        if (key === 'spaces') {
          patch.spaces = String(form.spaces || '')
            .split(/[,\s]+/)
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
          continue;
        }
        patch[key] = form[key];
      }
      return patch;
    }

    async function requestJson(path, options = {}) {
      const response = await fetch(`${BASE}${path}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...options,
        headers: { ...HEADERS, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) },
      });
      const text = await response.text();
      let payload = null;
      if (text !== '') {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { status: 'error', message: text.slice(0, 400) };
        }
      }
      return { ok: response.ok, status: response.status, payload: payload || {} };
    }

    function Field(props) {
      return h('div', { style: props.block === false ? undefined : styles.field },
        h('label', { style: styles.label, htmlFor: props.id }, props.label),
        h('input', {
          id: props.id, type: props.type || 'text', value: props.value,
          placeholder: props.placeholder, onChange: props.onChange,
          autoComplete: props.autoComplete || 'off', spellCheck: false,
          style: props.inputStyle || styles.input,
        }),
        props.hint ? h('p', { style: styles.hint }, props.hint) : null,
      );
    }

    function Select(props) {
      return h('div', { style: styles.field },
        h('label', { style: styles.label, htmlFor: props.id }, props.label),
        h('select', {
          id: props.id, value: props.value, onChange: props.onChange,
          style: { ...styles.input, appearance: 'auto' },
        }, props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
        props.hint ? h('p', { style: styles.hint }, props.hint) : null,
      );
    }

    function Switch(props) {
      return h('div', { style: styles.switchRow },
        h('div', null,
          h('div', { style: { ...styles.label, marginBottom: 2 } }, props.label),
          h('div', { style: { ...styles.hint, margin: 0, maxWidth: 420 } }, props.hint),
        ),
        h('button', {
          type: 'button', role: 'switch', 'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label, onClick: () => props.onChange(!props.checked), style: styles.switch(props.checked),
        }, h('span', { style: styles.knob(props.checked) })),
      );
    }

    function ConfluencePage() {
      const [state, setState] = useState(null);
      const [form, setForm] = useState(blankForm);
      const [status, setStatus] = useState({ kind: 'idle', text: '' });
      const [busy, setBusy] = useState('');
      const [tokenDraft, setTokenDraft] = useState('');
      const alive = useRef(true);

      useEffect(() => () => { alive.current = false; }, []);

      const load = useCallback(async (attempt = 0) => {
        try {
          const { payload } = await requestJson('/state');
          if (alive.current === false) return;
          if (payload.status === 'ok') {
            setState(payload);
            setForm(formFromState(payload));
            return;
          }
          setStatus({ kind: 'warn', text: payload.message || t('无法读取配置。', 'Could not read the configuration.') });
        } catch (error) {
          if (attempt < 1) {
            // A save re-applies the plugin and re-registers the routes.
            setTimeout(() => { void load(attempt + 1); }, 500);
            return;
          }
          if (alive.current === false) return;
          setStatus({ kind: 'error', text: String(error && error.message ? error.message : error) });
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const update = (key) => (event) => {
        const value = event && event.target ? event.target.value : event;
        setForm((current) => ({ ...current, [key]: value }));
      };

      const save = async () => {
        setBusy('save');
        setStatus({ kind: 'idle', text: t('正在保存…', 'Saving…') });
        try {
          const patch = patchFromForm(form);
          if (tokenDraft !== '') patch.token = tokenDraft;
          const { ok, payload } = await requestJson('/save', {
            method: 'POST',
            body: JSON.stringify({ patch, revision: state && state.revision !== null ? state.revision : undefined }),
          });
          if (ok !== true || payload.status !== 'saved') {
            setStatus({ kind: 'error', text: payload.message || t('保存被拒绝。', 'The save was rejected.') });
            setBusy('');
            return;
          }
          setTokenDraft('');
          const wrote = Array.isArray(payload.changed) ? payload.changed.join(', ') : '';
          setStatus({
            kind: 'ok',
            text: t(
              `已保存：${wrote}\n插件正在以新配置重新加载，写工具集合随后生效。`,
              `Saved: ${wrote}\nThe plugin is re-applying with this configuration; the write tool set follows.`,
            ),
          });
          setTimeout(() => { void load(); }, 600);
        } catch (error) {
          setStatus({ kind: 'error', text: String(error && error.message ? error.message : error) });
        } finally {
          setBusy('');
        }
      };

      const test = async () => {
        setBusy('test');
        setStatus({ kind: 'idle', text: t('正在连接 Confluence…', 'Contacting Confluence…') });
        try {
          const { payload } = await requestJson('/test', { method: 'POST', body: '{}' });
          if (payload.status === 'ok') {
            const sample = Array.isArray(payload.sample) && payload.sample.length > 0 ? `（${payload.sample.join(', ')}）` : '';
            setStatus({ kind: 'ok', text: `${payload.message}${sample}` });
          } else {
            setStatus({ kind: 'error', text: `${payload.code || 'CLI_FAILED'}: ${payload.message || ''}` });
          }
        } catch (error) {
          setStatus({ kind: 'error', text: String(error && error.message ? error.message : error) });
        } finally {
          setBusy('');
        }
      };

      const clearToken = async () => {
        setBusy('token');
        try {
          const { ok, payload } = await requestJson('/save', {
            method: 'POST',
            body: JSON.stringify({ patch: { token: '' }, revision: state && state.revision !== null ? state.revision : undefined }),
          });
          setStatus(ok === true && payload.status === 'saved'
            ? { kind: 'ok', text: t('已清除保存的 token。', 'The stored token was cleared.') }
            : { kind: 'error', text: payload.message || t('清除失败。', 'Could not clear the token.') });
          setTokenDraft('');
          setTimeout(() => { void load(); }, 500);
        } catch (error) {
          setStatus({ kind: 'error', text: String(error && error.message ? error.message : error) });
        } finally {
          setBusy('');
        }
      };

      const live = state && state.live ? state.live : null;
      const supported = state === null || state.supported !== false;
      const hasToken = Boolean(state && state.hasToken);

      return h('div', { style: styles.page },
        h('p', { style: styles.intro },
          t(
            '这里的设置只作用于 DeepSeek Harness 中的 Confluence 工具。保存后会写入本机设置文档的用户配置层，不修改 profile 的 patch 文件；工具在插件重新加载后使用新值。环境变量 CONFLUENCE_* 仍可覆盖这里留空的字段。',
            'These settings drive the Confluence tools inside DeepSeek Harness. Saving writes to this machine\'s settings document user layer, never to the profile patch; the tools use the new values after the plugin re-applies. CONFLUENCE_* environment variables still fill in anything left empty here.',
          ),
        ),

        supported === false
          ? h('div', { style: styles.status('warn') },
            t('当前部署没有 settings 服务，配置页只能读取。请在 profile patch 中配置。', 'This deployment has no settings service, so the page is read-only. Configure the plugin row instead.'))
          : null,

        h('div', { style: styles.group },
          h('div', { style: styles.groupTitle }, t('站点与认证', 'Site and authentication')),
          h('p', { style: styles.groupHint },
            t('Cloud 实例填 https://<site>.atlassian.net/wiki；Server/Data Center 填 https://confluence.example.com。',
              'For Cloud use https://<site>.atlassian.net/wiki; for Server/Data Center use https://confluence.example.com.')),
          h(Field, {
            id: 'confluence-site-url', label: t('站点地址', 'Site URL'),
            value: form.siteUrl, onChange: update('siteUrl'),
            placeholder: 'https://company.atlassian.net/wiki',
          }),
          h('div', { style: styles.pair },
            h('div', { style: { flex: 2 } }, h(Field, {
              id: 'confluence-domain', label: t('主机名（可选）', 'Host name (optional)'),
              value: form.domain, onChange: update('domain'),
              placeholder: 'company.atlassian.net',
              hint: t('与站点地址二选一；留空表示用站点地址推导。', 'Use either this or the site URL; empty derives it from the URL.'),
            })),
            h('div', { style: { flex: 2 } }, h(Field, {
              id: 'confluence-api-path', label: t('API 基路径', 'API base path'),
              value: form.apiPath, onChange: update('apiPath'),
              placeholder: '/wiki/rest/api',
              hint: t('Cloud 用 /wiki/rest/api，Server/DC 用 /rest/api。', 'Cloud: /wiki/rest/api. Server/DC: /rest/api.'),
            })),
          ),
          h(Select, {
            id: 'confluence-auth-type', label: t('认证方式', 'Authentication'),
            value: form.authType, onChange: update('authType'),
            options: [
              { value: 'basic', label: t('basic — 邮箱 + API token', 'basic — email + API token') },
              { value: 'bearer', label: t('bearer — personal access token', 'bearer — personal access token') },
            ],
          }),
          h('div', { style: styles.pair },
            h('div', { style: { flex: 1 } }, h(Field, {
              id: 'confluence-email', label: t('登录邮箱', 'Email'),
              value: form.email, onChange: update('email'),
              placeholder: 'you@company.com',
              hint: t('basic 认证必填；bearer 认证留空。', 'Required for basic; leave empty for bearer.'),
            })),
            h('div', { style: { flex: 1 } }, h(Field, {
              id: 'confluence-profile', label: t('CLI 配置名（可选）', 'CLI profile (optional)'),
              value: form.profile, onChange: update('profile'),
              placeholder: 'default',
            })),
          ),
          h('div', { style: styles.field },
            h('label', { style: styles.label, htmlFor: 'confluence-token' },
              t('API token', 'API token'),
              h('span', { style: { marginLeft: 8, ...styles.badge(hasToken) } },
                hasToken ? t('已保存', 'stored') : t('未设置', 'not set')),
            ),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                id: 'confluence-token', type: 'password', value: tokenDraft,
                placeholder: hasToken ? t('已保存，留空表示不修改', 'Stored — leave empty to keep it')
                  : t('粘贴 API token 或 personal access token', 'Paste an API token or personal access token'),
                onChange: (event) => setTokenDraft(event.target.value),
                autoComplete: 'new-password', spellCheck: false, style: styles.input,
              }),
              hasToken
                ? h('button', {
                  type: 'button', onClick: clearToken, disabled: busy !== '',
                  style: { ...styles.secondary, flex: '0 0 auto' },
                }, t('清除', 'Clear'))
                : null,
            ),
            h('p', { style: styles.hint },
              t('token 保存在本机 settings.yaml 的用户层，读取时按 secret 字段回显（只显示是否已设置）。也可以改用环境变量 CONFLUENCE_API_TOKEN，避免落盘。',
                'The token is stored in this machine\'s settings.yaml user layer and echoed back as a redacted secret (only whether it is set). You can use CONFLUENCE_API_TOKEN instead to keep it off disk.')),
          ),
        ),

        h('div', { style: styles.group },
          h('div', { style: styles.groupTitle }, t('写入权限', 'Write access')),
          h('p', { style: styles.groupHint },
            t('写工具默认不注册。开启后仍需至少一个允许空间，每次写操作都会先在本地预检，再请求审批。',
              'Write tools are not registered by default. Enabling them still requires at least one allowed space, and every write runs a local preflight before asking for approval.')),
          h(Switch, {
            label: t('注册写工具', 'Register write tools'),
            hint: t('关闭时只有 13 个只读工具可用。', 'When off, only the 13 read tools exist.'),
            checked: form.writes, onChange: (next) => setForm((current) => ({ ...current, writes: next })),
          }),
          h(Field, {
            id: 'confluence-spaces', label: t('允许的空间 key', 'Allowed space keys'),
            value: form.spaces, onChange: update('spaces'),
            placeholder: 'ENG, DOCS',
            hint: t('逗号或空格分隔；不支持通配符。留空等于关闭写工具。', 'Comma- or space-separated; no wildcards. Empty disables the write tools.'),
          }),
          h(Select, {
            id: 'confluence-confirm', label: t('审批方式', 'Approval'),
            value: form.confirm, onChange: update('confirm'),
            options: [
              { value: 'ask', label: t('ask — 每次写操作请求人工审批', 'ask — require approval for every write') },
              { value: 'never', label: t('never — 跳过审批（自担风险）', 'never — skip approval (at your own risk)') },
            ],
          }),
        ),

        h('div', { style: styles.group },
          h('div', { style: styles.groupTitle }, t('当前运行状态', 'Current runtime')),
          live === null
            ? h('p', { style: styles.groupHint }, t('读取中…', 'Reading…'))
            : h('div', { style: styles.meta },
              h('span', null, t('已注册工具', 'Tools registered')),
              h('span', null, `${live.tools}${live.writes ? t('（含写工具）', ' (writes included)') : t('（只读）', ' (read only)')}`),
              h('span', null, t('允许空间', 'Allowed spaces')),
              h('span', null, live.writes ? (live.spaces.length > 0 ? live.spaces.join(', ') : '—') : t('未启用', 'disabled')),
              h('span', null, t('审批方式', 'Approval')),
              h('span', null, live.confirm === 'never' ? t('never（跳过）', 'never (skipped)') : t('ask（每次询问）', 'ask')),
              h('span', null, t('CLI 目录', 'CLI root')),
              h('span', { style: { wordBreak: 'break-all' } }, live.packageRoot || '—'),
            ),
        ),

        h('div', { style: styles.actions },
          h('button', {
            type: 'button', onClick: save, disabled: busy !== '' || supported === false,
            style: { ...styles.primary, opacity: busy !== '' || supported === false ? 0.6 : 1 },
          }, busy === 'save' ? t('保存中…', 'Saving…') : t('保存并应用', 'Save and apply')),
          h('button', {
            type: 'button', onClick: test, disabled: busy !== '',
            style: { ...styles.secondary, opacity: busy !== '' ? 0.6 : 1 },
          }, busy === 'test' ? t('测试中…', 'Testing…') : t('测试连接', 'Test connection')),
          h('button', {
            type: 'button',
            onClick: () => { setForm(formFromState(state)); setTokenDraft(''); setStatus({ kind: 'idle', text: '' }); void load(); },
            disabled: busy !== '',
            style: { ...styles.secondary, opacity: busy !== '' ? 0.6 : 1 },
          }, t('重新读取', 'Reload')),
        ),

        status.text === '' ? null : h('div', { role: 'status', 'aria-live': 'polite', style: styles.status(status.kind) }, status.text),
      );
    }

    /** The settings navigation glyph: the same page mark the bundle icon draws. */
    function SectionIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 36 36', 'aria-hidden': 'true',
        style: { display: 'block', opacity: props && props.active ? 1 : 0.72 },
      },
      h('path', {
        d: 'M10.5 4.5h10.2L27 10.8v17.7a2.6 2.6 0 0 1-2.6 2.6H10.5a2.6 2.6 0 0 1-2.6-2.6V7.1a2.6 2.6 0 0 1 2.6-2.6z',
        fill: 'currentColor',
      }),
      h('path', { d: 'M20.7 4.5 27 10.8h-4.4a1.9 1.9 0 0 1-1.9-1.9z', fill: 'var(--dsw-alias-bg-layer-1)' }),
      h('g', { stroke: 'var(--dsw-alias-bg-layer-1)', strokeWidth: 1.9, strokeLinecap: 'round' },
        h('path', { d: 'M12.4 15.4h10.2' }),
        h('path', { d: 'M12.4 19.6h10.2' }),
        h('path', { d: 'M12.4 23.8h6.1' }),
      ),
      );
    }

    function apply(ctx) {
      const slots = ctx.slots;
      ctx.effect(() => slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'confluence', order: 26, label: () => t('Confluence', 'Confluence') },
        () => h(ConfluencePage),
      )));
      ctx.effect(() => slots.inject('settings.section.icon', () => slots.register(
        { name: 'settings.section.icon', id: 'confluence' },
        () => h(SectionIcon),
      )));
    }

    return { name: 'dsh-plugin-confluence', inject: ['slots'], apply };
  },
});
