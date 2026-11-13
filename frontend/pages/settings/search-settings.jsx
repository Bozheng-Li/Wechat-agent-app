import { useState } from 'react';

const names = { deepseek: 'DeepSeek', tavily: 'Tavily' };
const missing = {
  deepseek: '尚未保存 DeepSeek 搜索密钥，可直接填写 DeepSeek 官方 API Key。',
  tavily: '尚未保存 Tavily 搜索密钥。',
};

export function SearchControls({ draft, status, blocked, onChange, Field }) {
  const selected = draft.searchProvider === 'dsh' ? 'deepseek' : draft.searchProvider || 'tavily',
    last = status.lastSearch,
    deepseek = selected === 'deepseek';
  return (
    <div className="wa-search-controls" data-testid="search-settings">
      <Field label="搜索服务" id="wa-search-provider">
        <select
          className="wa-select"
          id="wa-search-provider"
          value={selected}
          disabled={blocked || !draft.webSearch}
          onChange={(event) => onChange({ ...draft, searchProvider: event.target.value })}
        >
          <option value="deepseek">DeepSeek 搜索</option>
          <option value="tavily">Tavily 搜索</option>
        </select>
      </Field>
      {deepseek ? (
        <div className="wa-search-fields" data-provider="deepseek">
          <Field
            label="DeepSeek 服务地址"
            id="wa-deepseek-url"
            help="填写 DeepSeek 或其他 Anthropic 兼容服务的 HTTPS 地址，联网搜索调用该地址下的 /messages 接口。"
          >
            <input
              className="wa-input"
              id="wa-deepseek-url"
              type="url"
              value={draft.deepseekBaseURL}
              disabled={blocked || !draft.webSearch}
              onChange={(event) => onChange({ ...draft, deepseekBaseURL: event.target.value })}
            />
          </Field>
          <Field label="搜索模型" id="wa-deepseek-model" help="选择服务端支持 web_search 工具的模型，默认 deepseek-v4-flash。">
            <input
              className="wa-input"
              id="wa-deepseek-model"
              type="text"
              maxLength={120}
              value={draft.deepseekModel}
              disabled={blocked || !draft.webSearch}
              onChange={(event) => onChange({ ...draft, deepseekModel: event.target.value })}
            />
          </Field>
          <p className="wa-help">由 DeepSeek 在服务端完成检索并回传来源列表，不需要额外的搜索引擎账号。</p>
        </div>
      ) : (
        <div className="wa-search-fields" data-provider="tavily">
          <Field label="Tavily 服务地址" id="wa-tavily-url" help="填写 Tavily 或兼容服务的 HTTPS 地址。">
            <input
              className="wa-input"
              id="wa-tavily-url"
              type="url"
              value={draft.tavilyBaseURL}
              disabled={blocked || !draft.webSearch}
              onChange={(event) => onChange({ ...draft, tavilyBaseURL: event.target.value })}
            />
          </Field>
          <p className="wa-help">通过已配置的 Tavily API 查询必要的公开主题，回复保留来源。</p>
        </div>
      )}
      {last && (
        <p className="wa-help" data-testid="search-status" role={last.ok ? 'status' : 'alert'}>
          {last.fallbackUsed ? `已从${names[last.primaryProvider] || '默认接口'}回退至${names[last.provider] || '备用接口'}：` : `${names[last.provider] || '搜索服务'}最近一次查询：`}
          {last.ok ? `已完成，取得 ${last.sourceCount} 条可引用结果。` : last.message}
        </p>
      )}
    </div>
  );
}

export function SearchCredentials({ status, blocked, busy, onSave, Field, Button }) {
  const [values, setValues] = useState({ deepseek: '', tavily: '' });
  const save = async (provider) => {
    const submitted = values[provider],
      result = await onSave(provider, submitted);
    if (result) setValues((current) => (current[provider] === submitted ? { ...current, [provider]: '' } : current));
  };
  return (
    <section className="wa-settings-block wa-search-credentials">
      <details className="wa-data-details" data-testid="search-credentials">
        <summary>搜索密钥</summary>
        <p className="wa-help">密钥由 Windows 加密保存在本机；再次打开只显示配置状态。</p>
        {Object.keys(names).map((provider) => (
          <form
            key={provider}
            className="wa-subsection wa-credential-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save(provider);
            }}
          >
            <Field
              label={`${names[provider]} API Key`}
              id={`wa-search-key-${provider}`}
              help={status.search?.credentials?.[provider] ? '已保存；填写新密钥可替换。' : missing[provider]}
            >
              <input
                className="wa-input"
                id={`wa-search-key-${provider}`}
                type="password"
                autoComplete="new-password"
                maxLength={512}
                value={values[provider]}
                disabled={blocked || !status.search?.credentialStore}
                onChange={(event) => setValues((current) => ({ ...current, [provider]: event.target.value }))}
              />
            </Field>
            <div className="wa-form-actions">
              <Button
                type="submit"
                primary
                disabled={blocked || !status.search?.credentialStore || !values[provider].trim()}
              >
                {busy === 'search.credentials' ? '正在保存…' : `保存${names[provider]}密钥`}
              </Button>
            </div>
          </form>
        ))}
      </details>
    </section>
  );
}
