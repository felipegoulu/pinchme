'use client';

import { useState, useEffect } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function Dashboard() {
  const [auth, setAuth] = useState({ checked: false, authenticated: false, username: '' });
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');
  
  const [config, setConfig] = useState({
    webhookUrl: '',
    handles: [],
    pollIntervalMinutes: 15,
  });
  const [newHandle, setNewHandle] = useState('');
  const [handlePreview, setHandlePreview] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ current: '', new: '', confirm: '' });
  const [passwordError, setPasswordError] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  
  const [handleConfigs, setHandleConfigs] = useState({});
  const [editingHandle, setEditingHandle] = useState(null);
  const [handleConfigForm, setHandleConfigForm] = useState({ mode: 'now', prompt: '', channel: '' });
  
  // OpenClaw config
  const [openclawConfig, setOpenclawConfig] = useState(null);
  const [openclawHeartbeat, setOpenclawHeartbeat] = useState(null);
  const [savingOpenclaw, setSavingOpenclaw] = useState(false);

  useEffect(() => { checkAuth(); }, []);

  useEffect(() => {
    if (!newHandle || newHandle.length < 2) { setHandlePreview(null); return; }
    const timer = setTimeout(() => {
      const clean = newHandle.replace(/^@/, '').trim();
      if (clean) setHandlePreview({ handle: clean, url: `https://x.com/${clean}` });
    }, 300);
    return () => clearTimeout(timer);
  }, [newHandle]);

  function getToken() { return typeof window !== 'undefined' ? localStorage.getItem('token') : null; }
  function setToken(t) { localStorage.setItem('token', t); }
  function clearToken() { localStorage.removeItem('token'); }
  function authHeaders() { const t = getToken(); return t ? { Authorization: `Bearer ${t}` } : {}; }

  async function checkAuth() {
    const token = getToken();
    if (!token) { setAuth({ checked: true, authenticated: false, username: '' }); setLoading(false); return; }
    try {
      const res = await fetch(`${API_URL}/auth/me`, { headers: authHeaders() });
      const data = await res.json();
      if (data.authenticated) {
        setAuth({ checked: true, authenticated: true, username: data.username });
        fetchConfig(); fetchStatus(); fetchHandleConfigs();
      } else { clearToken(); setAuth({ checked: true, authenticated: false, username: '' }); setLoading(false); }
    } catch { clearToken(); setAuth({ checked: true, authenticated: false, username: '' }); setLoading(false); }
  }

  async function handleLogin(e) {
    e.preventDefault(); setLoginError('');
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginForm),
      });
      const data = await res.json();
      if (data.success) { setToken(data.token); setAuth({ checked: true, authenticated: true, username: data.username }); fetchConfig(); fetchStatus(); fetchHandleConfigs(); }
      else setLoginError(data.error || 'Login failed');
    } catch { setLoginError('Connection error'); }
  }

  async function handleLogout() {
    try { await fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: authHeaders() }); } catch {}
    clearToken(); setAuth({ checked: true, authenticated: false, username: '' });
  }

  async function handleChangePassword(e) {
    e.preventDefault(); setPasswordError('');
    if (passwordForm.new !== passwordForm.confirm) { setPasswordError('Passwords do not match'); return; }
    if (passwordForm.new.length < 4) { setPasswordError('Min 4 characters'); return; }
    setChangingPassword(true);
    try {
      const res = await fetch(`${API_URL}/auth/password`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ currentPassword: passwordForm.current, newPassword: passwordForm.new }),
      });
      const data = await res.json();
      if (data.success) { setShowPasswordModal(false); setPasswordForm({ current: '', new: '', confirm: '' }); setMessage({ type: 'success', text: 'Password updated' }); }
      else setPasswordError(data.error || 'Failed');
    } catch { setPasswordError('Connection error'); }
    finally { setChangingPassword(false); }
  }

  async function fetchConfig() {
    try {
      const res = await fetch(`${API_URL}/config`, { headers: authHeaders() });
      if (res.ok) setConfig(await res.json());
      else if (res.status === 401) { clearToken(); setAuth({ checked: true, authenticated: false, username: '' }); }
    } catch { setMessage({ type: 'error', text: 'Failed to load config' }); }
    finally { setLoading(false); }
  }

  async function fetchStatus() {
    try { const res = await fetch(`${API_URL}/status`, { headers: authHeaders() }); if (res.ok) setStatus(await res.json()); } catch {}
  }

  async function fetchHandleConfigs() {
    try {
      const res = await fetch(`${API_URL}/handle-config`, { headers: authHeaders() });
      if (res.ok) {
        const configs = await res.json();
        const configMap = {};
        configs.forEach(c => { configMap[c.handle] = c; });
        setHandleConfigs(configMap);
      }
    } catch {}
  }

  async function saveHandleConfig(handle) {
    try {
      const res = await fetch(`${API_URL}/handle-config/${handle}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(handleConfigForm),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: `Config saved for @${handle}` });
        fetchHandleConfigs();
        setEditingHandle(null);
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Failed to save' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Connection error' });
    }
  }

  function openHandleConfig(handle) {
    const existing = handleConfigs[handle] || { mode: 'now', prompt: '', channel: '' };
    setHandleConfigForm({ mode: existing.mode || 'now', prompt: existing.prompt || '', channel: existing.channel || '' });
    setEditingHandle(handle);
  }

  // OpenClaw config functions
  async function fetchOpenclawConfig() {
    if (!config.webhookUrl) return;
    try {
      const webhookBase = config.webhookUrl.replace(/\/$/, '');
      const res = await fetch(`${webhookBase}/openclaw/config`);
      if (res.ok) {
        setOpenclawConfig(await res.json());
        fetchOpenclawHeartbeat();
      }
    } catch (err) {
      console.log('OpenClaw config not available:', err.message);
    }
  }

  async function fetchOpenclawHeartbeat() {
    if (!config.webhookUrl) return;
    try {
      const webhookBase = config.webhookUrl.replace(/\/$/, '');
      const res = await fetch(`${webhookBase}/openclaw/heartbeat`);
      if (res.ok) setOpenclawHeartbeat(await res.json());
    } catch {}
  }

  async function saveOpenclawConfig(newConfig) {
    if (!config.webhookUrl) return;
    setSavingOpenclaw(true);
    try {
      const webhookBase = config.webhookUrl.replace(/\/$/, '');
      const res = await fetch(`${webhookBase}/openclaw/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: 'OpenClaw config saved & gateway restarted' });
        setOpenclawConfig(newConfig);
        setTimeout(fetchOpenclawHeartbeat, 2000);
      } else {
        setMessage({ type: 'error', text: 'Failed to save OpenClaw config' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Connection error' });
    } finally {
      setSavingOpenclaw(false);
    }
  }

  function updateHeartbeatConfig(key, value) {
    if (!openclawConfig) return;
    const updated = { ...openclawConfig };
    if (!updated.agents) updated.agents = {};
    if (!updated.agents.defaults) updated.agents.defaults = {};
    if (!updated.agents.defaults.heartbeat) updated.agents.defaults.heartbeat = {};
    updated.agents.defaults.heartbeat[key] = value;
    setOpenclawConfig(updated);
  }

  function updateChannelHeartbeat(channel, key, value) {
    if (!openclawConfig) return;
    const updated = { ...openclawConfig };
    if (!updated.channels) updated.channels = {};
    if (!updated.channels[channel]) updated.channels[channel] = {};
    if (!updated.channels[channel].heartbeat) updated.channels[channel].heartbeat = {};
    updated.channels[channel].heartbeat[key] = value;
    setOpenclawConfig(updated);
  }

  // Fetch openclaw config when webhook URL is available
  useEffect(() => {
    if (config.webhookUrl) fetchOpenclawConfig();
  }, [config.webhookUrl]);

  async function saveConfig() {
    setSaving(true); setMessage(null);
    try {
      const res = await fetch(`${API_URL}/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(config),
      });
      if (res.ok) { setMessage({ type: 'success', text: 'Saved' }); fetchStatus(); }
      else { const err = await res.json(); setMessage({ type: 'error', text: err.error || 'Failed' }); }
    } catch { setMessage({ type: 'error', text: 'Connection error' }); }
    finally { setSaving(false); }
  }

  async function triggerPoll() {
    try { await fetch(`${API_URL}/poll`, { method: 'POST', headers: authHeaders() }); setMessage({ type: 'success', text: 'Poll started' }); setTimeout(fetchStatus, 3000); }
    catch { setMessage({ type: 'error', text: 'Failed' }); }
  }

  function addHandle() {
    const h = newHandle.replace(/^@/, '').trim().toLowerCase();
    if (h && !config.handles.includes(h)) { setConfig({ ...config, handles: [...config.handles, h] }); setNewHandle(''); setHandlePreview(null); }
  }

  function removeHandle(h) { setConfig({ ...config, handles: config.handles.filter(x => x !== h) }); }

  // Login
  if (auth.checked && !auth.authenticated) {
    return (
      <div className="page">
        <div className="login-container">
          <div className="login-box">
            <h1>Tweet Watcher</h1>
            <p className="subtitle">Sign in to continue</p>
            {loginError && <div className="error-msg">{loginError}</div>}
            <form onSubmit={handleLogin}>
              <input type="text" placeholder="Username" value={loginForm.username} onChange={e => setLoginForm({...loginForm, username: e.target.value})} />
              <input type="password" placeholder="Password" value={loginForm.password} onChange={e => setLoginForm({...loginForm, password: e.target.value})} />
              <button type="submit" className="btn-primary">Continue</button>
            </form>
          </div>
        </div>
        <style jsx>{styles}</style>
      </div>
    );
  }

  if (!auth.checked || loading) {
    return (<div className="page"><div className="loading">Loading...</div><style jsx>{styles}</style></div>);
  }

  return (
    <div className="page">
      <nav className="nav">
        <div className="nav-left">
          <span className="logo">⚡</span>
          <span className="nav-title">Tweet Watcher</span>
        </div>
        <div className="nav-right">
          <button className="nav-btn" onClick={() => setShowPasswordModal(true)}>Settings</button>
          <div className="nav-user">{auth.username}</div>
          <button className="nav-btn" onClick={handleLogout}>Logout</button>
        </div>
      </nav>

      <main className="main">
        {message && (
          <div className={`toast ${message.type}`}>
            {message.text}
            <button onClick={() => setMessage(null)}>×</button>
          </div>
        )}

        <div className="section">
          <div className="section-header">
            <h2>Webhook</h2>
          </div>
          <div className="section-body">
            <label>Endpoint URL</label>
            <input 
              type="url" 
              value={config.webhookUrl} 
              onChange={e => setConfig({...config, webhookUrl: e.target.value})}
              placeholder="https://example.com/webhook"
            />
            <span className="hint">New tweets will be sent here as POST requests</span>
          </div>
        </div>

        <div className="section">
          <div className="section-header">
            <h2>Accounts</h2>
            <span className="count">{config.handles.length}</span>
          </div>
          <div className="section-body">
            <label>Add Account</label>
            <div className="input-row">
              <div className="handle-input-wrap">
                <span className="at">@</span>
                <input 
                  type="text" 
                  value={newHandle} 
                  onChange={e => setNewHandle(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addHandle())}
                  placeholder="username"
                />
              </div>
              <button className="btn-secondary" onClick={addHandle} disabled={!newHandle.trim()}>Add</button>
            </div>
            
            {handlePreview && (
              <div className="preview">
                <span>@{handlePreview.handle}</span>
                <a href={handlePreview.url} target="_blank" rel="noopener noreferrer">View on X →</a>
              </div>
            )}

            <div className="handles">
              {config.handles.length === 0 ? (
                <div className="empty">No accounts added</div>
              ) : (
                config.handles.map(h => (
                  <div key={h} className="handle-tag">
                    <a href={`https://x.com/${h}`} target="_blank" rel="noopener noreferrer">@{h}</a>
                    {handleConfigs[h]?.prompt && <span className="config-badge" title="Has custom prompt">⚡</span>}
                    <button className="config-btn" onClick={() => openHandleConfig(h)} title="Configure">⚙</button>
                    <button onClick={() => removeHandle(h)}>×</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="section">
          <div className="section-header">
            <h2>Polling</h2>
            <span className="count">{config.pollIntervalMinutes}m</span>
          </div>
          <div className="section-body">
            <label>Interval</label>
            <input 
              type="range" 
              min="1" 
              max="60" 
              value={config.pollIntervalMinutes}
              onChange={e => setConfig({...config, pollIntervalMinutes: parseInt(e.target.value)})}
            />
            <div className="range-labels">
              <span>1 min</span>
              <span>60 min</span>
            </div>
            <span className="hint">
              Estimated: ~${(0.40 * Math.max(1, config.handles.length) * (60 / config.pollIntervalMinutes) * 24).toFixed(2)}/day
            </span>
          </div>
        </div>

        {status && (
          <div className="section status-section">
            <div className="status-row">
              <div className="status-item">
                <span className="status-label">Status</span>
                <span className="status-value online">● Online</span>
              </div>
              <div className="status-item">
                <span className="status-label">Tracking</span>
                <span className="status-value">{Object.keys(status.state?.lastSeenIds || {}).length} accounts</span>
              </div>
              <div className="status-item">
                <span className="status-label">Last poll</span>
                <span className="status-value">{status.state?.lastPoll ? new Date(status.state.lastPoll).toLocaleTimeString() : '—'}</span>
              </div>
            </div>
          </div>
        )}

        {openclawConfig && (
          <div className="section">
            <div className="section-header">
              <h2>🦞 OpenClaw</h2>
              {openclawHeartbeat && (
                <span className={`status-badge ${openclawHeartbeat.status === 'ok-token' ? 'ok' : ''}`}>
                  {openclawHeartbeat.status === 'ok-token' ? '● OK' : openclawHeartbeat.status}
                </span>
              )}
            </div>
            <div className="section-body">
              <label>Heartbeat Interval</label>
              <div className="input-row">
                <input 
                  type="text" 
                  value={openclawConfig?.agents?.defaults?.heartbeat?.every || '30m'}
                  onChange={e => updateHeartbeatConfig('every', e.target.value)}
                  placeholder="30m"
                  style={{width: '100px'}}
                />
                <span className="hint-inline">e.g., 5m, 15m, 1h</span>
              </div>

              <label>Target Channel</label>
              <select 
                value={openclawConfig?.agents?.defaults?.heartbeat?.target || 'last'}
                onChange={e => updateHeartbeatConfig('target', e.target.value)}
              >
                <option value="last">Last active</option>
                <option value="telegram">Telegram</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="discord">Discord</option>
                <option value="none">None (silent)</option>
              </select>

              {openclawConfig?.agents?.defaults?.heartbeat?.target === 'telegram' && (
                <>
                  <label>Telegram Chat ID</label>
                  <input 
                    type="text" 
                    value={openclawConfig?.agents?.defaults?.heartbeat?.to || ''}
                    onChange={e => updateHeartbeatConfig('to', e.target.value)}
                    placeholder="e.g., 5679450975"
                  />
                </>
              )}

              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input 
                    type="checkbox"
                    checked={openclawConfig?.agents?.defaults?.heartbeat?.includeReasoning || false}
                    onChange={e => updateHeartbeatConfig('includeReasoning', e.target.checked)}
                  />
                  <span>Include Reasoning</span>
                  <span className="hint-small">Show thinking process</span>
                </label>
              </div>

              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input 
                    type="checkbox"
                    checked={openclawConfig?.channels?.telegram?.heartbeat?.showOk || false}
                    onChange={e => updateChannelHeartbeat('telegram', 'showOk', e.target.checked)}
                  />
                  <span>Show OK Messages</span>
                  <span className="hint-small">Send message even when nothing to report</span>
                </label>
              </div>

              {openclawHeartbeat && (
                <div className="heartbeat-status">
                  <span className="hint">Last heartbeat: {openclawHeartbeat.status} 
                    {openclawHeartbeat.durationMs && ` (${openclawHeartbeat.durationMs}ms)`}
                    {openclawHeartbeat.silent && ' — silent'}
                  </span>
                </div>
              )}

              <div className="actions" style={{marginTop: '16px', justifyContent: 'flex-start'}}>
                <button 
                  className="btn-primary" 
                  onClick={() => saveOpenclawConfig(openclawConfig)}
                  disabled={savingOpenclaw}
                >
                  {savingOpenclaw ? 'Saving...' : 'Save OpenClaw Config'}
                </button>
                <button 
                  className="btn-secondary" 
                  onClick={fetchOpenclawHeartbeat}
                >
                  Refresh Status
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="actions">
          <button className="btn-secondary" onClick={triggerPoll}>Poll Now</button>
          <button className="btn-primary" onClick={saveConfig} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </main>

      {showPasswordModal && (
        <div className="modal-overlay" onClick={() => setShowPasswordModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Change Password</h3>
            {passwordError && <div className="error-msg">{passwordError}</div>}
            <form onSubmit={handleChangePassword}>
              <label>Current Password</label>
              <input type="password" value={passwordForm.current} onChange={e => setPasswordForm({...passwordForm, current: e.target.value})} />
              <label>New Password</label>
              <input type="password" value={passwordForm.new} onChange={e => setPasswordForm({...passwordForm, new: e.target.value})} />
              <label>Confirm Password</label>
              <input type="password" value={passwordForm.confirm} onChange={e => setPasswordForm({...passwordForm, confirm: e.target.value})} />
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowPasswordModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={changingPassword}>{changingPassword ? 'Saving...' : 'Update'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingHandle && (
        <div className="modal-overlay" onClick={() => setEditingHandle(null)}>
          <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
            <h3>Configure @{editingHandle}</h3>
            
            <label>Mode</label>
            <div className="radio-group">
              <label className={`radio-option ${handleConfigForm.mode === 'now' ? 'selected' : ''}`}>
                <input type="radio" name="mode" value="now" checked={handleConfigForm.mode === 'now'} onChange={e => setHandleConfigForm({...handleConfigForm, mode: e.target.value})} />
                <span className="radio-label">Instant</span>
                <span className="radio-desc">Notify immediately</span>
              </label>
              <label className={`radio-option ${handleConfigForm.mode === 'next-heartbeat' ? 'selected' : ''}`}>
                <input type="radio" name="mode" value="next-heartbeat" checked={handleConfigForm.mode === 'next-heartbeat'} onChange={e => setHandleConfigForm({...handleConfigForm, mode: e.target.value})} />
                <span className="radio-label">Batched</span>
                <span className="radio-desc">Wait for next heartbeat</span>
              </label>
            </div>

            <label>Channel</label>
            <select value={handleConfigForm.channel} onChange={e => setHandleConfigForm({...handleConfigForm, channel: e.target.value})}>
              <option value="">Default (active session)</option>
              <option value="telegram">Telegram</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="discord">Discord</option>
            </select>
            <span className="hint">Where to send notifications</span>

            <label>Custom Prompt</label>
            <textarea 
              value={handleConfigForm.prompt} 
              onChange={e => setHandleConfigForm({...handleConfigForm, prompt: e.target.value})}
              placeholder="e.g., Analyze this tweet and give your opinion"
              rows={3}
            />
            <span className="hint">Instructions for how OpenClaw should process tweets from this account</span>

            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setEditingHandle(null)}>Cancel</button>
              <button type="button" className="btn-primary" onClick={() => saveHandleConfig(editingHandle)}>Save</button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{styles}</style>
    </div>
  );
}

const styles = `
  .page {
    min-height: 100vh;
    background: #000;
    color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  .nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 24px;
    height: 64px;
    border-bottom: 1px solid #333;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(10px);
    z-index: 100;
  }

  .nav-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .logo {
    font-size: 20px;
  }

  .nav-title {
    font-size: 14px;
    font-weight: 500;
  }

  .nav-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .nav-btn {
    background: none;
    border: none;
    color: #888;
    font-size: 14px;
    cursor: pointer;
    padding: 8px 12px;
    border-radius: 6px;
    transition: all 0.15s;
  }

  .nav-btn:hover {
    color: #fff;
    background: #111;
  }

  .nav-user {
    font-size: 14px;
    color: #888;
    padding: 6px 12px;
    background: #111;
    border-radius: 6px;
  }

  .main {
    max-width: 680px;
    margin: 0 auto;
    padding: 48px 24px;
    padding-top: 112px;
  }

  .section {
    border: 1px solid #333;
    border-radius: 12px;
    margin-bottom: 24px;
    background: #0a0a0a;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid #333;
  }

  .section-header h2 {
    font-size: 14px;
    font-weight: 500;
    margin: 0;
  }

  .count {
    font-size: 12px;
    color: #666;
    background: #1a1a1a;
    padding: 4px 8px;
    border-radius: 4px;
  }

  .section-body {
    padding: 20px;
  }

  label {
    display: block;
    font-size: 13px;
    color: #888;
    margin-bottom: 8px;
  }

  input[type="text"],
  input[type="url"],
  input[type="password"] {
    width: 100%;
    padding: 10px 12px;
    font-size: 14px;
    background: #111;
    border: 1px solid #333;
    border-radius: 6px;
    color: #fafafa;
    outline: none;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }

  input:focus {
    border-color: #666;
  }

  input::placeholder {
    color: #444;
  }

  .hint {
    display: block;
    font-size: 12px;
    color: #666;
    margin-top: 8px;
  }

  .input-row {
    display: flex;
    gap: 12px;
  }

  .handle-input-wrap {
    flex: 1;
    position: relative;
  }

  .handle-input-wrap .at {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: #666;
  }

  .handle-input-wrap input {
    padding-left: 28px;
  }

  .preview {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    background: #111;
    border-radius: 8px;
    margin-top: 12px;
    font-size: 13px;
  }

  .preview a {
    color: #0070f3;
    text-decoration: none;
  }

  .handles {
    margin-top: 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .handle-tag {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 6px;
    font-size: 13px;
  }

  .handle-tag a {
    color: #fafafa;
    text-decoration: none;
  }

  .handle-tag button {
    background: none;
    border: none;
    color: #666;
    font-size: 16px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .handle-tag button:hover {
    color: #f00;
  }

  .empty {
    color: #666;
    font-size: 13px;
    padding: 20px 0;
    text-align: center;
  }

  input[type="range"] {
    width: 100%;
    height: 4px;
    background: #333;
    border-radius: 2px;
    appearance: none;
    cursor: pointer;
  }

  input[type="range"]::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    background: #fff;
    border-radius: 50%;
    cursor: pointer;
  }

  .range-labels {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: #666;
    margin-top: 8px;
  }

  .status-section {
    background: transparent;
    border: 1px solid #333;
  }

  .status-row {
    display: flex;
    padding: 16px 20px;
    gap: 32px;
  }

  .status-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .status-label {
    font-size: 12px;
    color: #666;
  }

  .status-value {
    font-size: 14px;
  }

  .status-value.online {
    color: #0070f3;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 32px;
  }

  .btn-primary {
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 500;
    background: #fff;
    color: #000;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .btn-primary:hover {
    opacity: 0.9;
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 500;
    background: transparent;
    color: #fafafa;
    border: 1px solid #333;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-secondary:hover {
    border-color: #666;
  }

  .btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toast {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-radius: 8px;
    margin-bottom: 24px;
    font-size: 14px;
  }

  .toast.success {
    background: rgba(0, 112, 243, 0.1);
    border: 1px solid #0070f3;
    color: #0070f3;
  }

  .toast.error {
    background: rgba(255, 0, 0, 0.1);
    border: 1px solid #f00;
    color: #f00;
  }

  .toast button {
    background: none;
    border: none;
    color: inherit;
    font-size: 18px;
    cursor: pointer;
    opacity: 0.7;
  }

  /* Login */
  .login-container {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .login-box {
    width: 100%;
    max-width: 360px;
    padding: 32px;
  }

  .login-box h1 {
    font-size: 24px;
    font-weight: 600;
    margin: 0 0 8px;
    text-align: center;
  }

  .login-box .subtitle {
    color: #666;
    text-align: center;
    margin-bottom: 32px;
  }

  .login-box input {
    margin-bottom: 16px;
  }

  .login-box .btn-primary {
    width: 100%;
    margin-top: 8px;
  }

  .error-msg {
    background: rgba(255, 0, 0, 0.1);
    border: 1px solid #f00;
    color: #f00;
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 13px;
    margin-bottom: 16px;
  }

  .loading {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #666;
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: #0a0a0a;
    border: 1px solid #333;
    border-radius: 12px;
    padding: 24px;
    width: 100%;
    max-width: 400px;
  }

  .modal h3 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 20px;
  }

  .modal label {
    margin-top: 12px;
  }

  .modal input {
    margin-bottom: 0;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 24px;
  }

  .modal-wide {
    max-width: 480px;
  }

  .config-badge {
    font-size: 12px;
    margin-left: 4px;
  }

  .config-btn {
    background: none;
    border: none;
    color: #666;
    font-size: 14px;
    cursor: pointer;
    padding: 0 4px;
    opacity: 0.7;
    transition: opacity 0.15s;
  }

  .config-btn:hover {
    opacity: 1;
    color: #0070f3;
  }

  .radio-group {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
  }

  .radio-option {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 12px;
    background: #111;
    border: 1px solid #333;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .radio-option:hover {
    border-color: #666;
  }

  .radio-option.selected {
    border-color: #0070f3;
    background: rgba(0, 112, 243, 0.1);
  }

  .radio-option input {
    display: none;
  }

  .radio-label {
    font-size: 14px;
    font-weight: 500;
    margin-bottom: 4px;
  }

  .radio-desc {
    font-size: 12px;
    color: #666;
  }

  select {
    width: 100%;
    padding: 10px 12px;
    font-size: 14px;
    background: #111;
    border: 1px solid #333;
    border-radius: 6px;
    color: #fafafa;
    outline: none;
    cursor: pointer;
    margin-bottom: 4px;
  }

  select:focus {
    border-color: #666;
  }

  textarea {
    width: 100%;
    padding: 10px 12px;
    font-size: 14px;
    background: #111;
    border: 1px solid #333;
    border-radius: 6px;
    color: #fafafa;
    outline: none;
    resize: vertical;
    font-family: inherit;
    box-sizing: border-box;
  }

  textarea:focus {
    border-color: #666;
  }

  textarea::placeholder {
    color: #444;
  }

  .status-badge {
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 4px;
    background: #1a1a1a;
    color: #666;
  }

  .status-badge.ok {
    background: rgba(0, 200, 100, 0.1);
    color: #0c8;
  }

  .hint-inline {
    font-size: 12px;
    color: #666;
    margin-left: 12px;
  }

  .hint-small {
    font-size: 11px;
    color: #666;
    margin-left: 8px;
  }

  .checkbox-group {
    margin-top: 16px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 14px;
  }

  .checkbox-label input[type="checkbox"] {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .heartbeat-status {
    margin-top: 16px;
    padding: 12px;
    background: #111;
    border-radius: 8px;
  }
`;
