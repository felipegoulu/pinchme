'use client';

import { useState, useEffect } from 'react';

const API_URL = 'https://elon-watcher-production.up.railway.app';

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
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    checkAuth();
  }, []);

  function getToken() {
    return localStorage.getItem('token');
  }

  function setToken(token) {
    localStorage.setItem('token', token);
  }

  function clearToken() {
    localStorage.removeItem('token');
  }

  function authHeaders() {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function checkAuth() {
    const token = getToken();
    if (!token) {
      setAuth({ checked: true, authenticated: false, username: '' });
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`${API_URL}/auth/me`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      
      if (data.authenticated) {
        setAuth({ checked: true, authenticated: true, username: data.username });
        fetchConfig();
        fetchStatus();
      } else {
        clearToken();
        setAuth({ checked: true, authenticated: false, username: '' });
        setLoading(false);
      }
    } catch (err) {
      clearToken();
      setAuth({ checked: true, authenticated: false, username: '' });
      setLoading(false);
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError('');

    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginForm),
      });
      
      const data = await res.json();
      
      if (data.success) {
        setToken(data.token);
        setAuth({ checked: true, authenticated: true, username: data.username });
        fetchConfig();
        fetchStatus();
      } else {
        setLoginError(data.error || 'Login failed');
      }
    } catch (err) {
      setLoginError('Connection error');
    }
  }

  async function handleLogout() {
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        headers: authHeaders(),
      });
    } catch (err) {}
    
    clearToken();
    setAuth({ checked: true, authenticated: false, username: '' });
  }

  async function fetchConfig() {
    try {
      const res = await fetch(`${API_URL}/config`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
      } else if (res.status === 401) {
        clearToken();
        setAuth({ checked: true, authenticated: false, username: '' });
      }
    } catch (err) {
      console.error('Failed to fetch config:', err);
      setMessage({ type: 'error', text: 'Failed to connect to backend' });
    } finally {
      setLoading(false);
    }
  }

  async function fetchStatus() {
    try {
      const res = await fetch(`${API_URL}/status`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (err) {
      console.error('Failed to fetch status:', err);
    }
  }

  async function saveConfig() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_URL}/config`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify(config),
      });
      
      if (res.ok) {
        setMessage({ type: 'success', text: 'Config saved! Polling restarted.' });
        fetchStatus();
      } else if (res.status === 401) {
        clearToken();
        setAuth({ checked: true, authenticated: false, username: '' });
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Failed to save' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to connect to backend' });
    } finally {
      setSaving(false);
    }
  }

  async function triggerPoll() {
    try {
      await fetch(`${API_URL}/poll`, { 
        method: 'POST',
        headers: authHeaders(),
      });
      setMessage({ type: 'success', text: 'Poll triggered!' });
      setTimeout(fetchStatus, 2000);
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to trigger poll' });
    }
  }

  function addHandle() {
    const handle = newHandle.replace(/^@/, '').trim().toLowerCase();
    if (handle && !config.handles.includes(handle)) {
      setConfig({ ...config, handles: [...config.handles, handle] });
      setNewHandle('');
    }
  }

  function removeHandle(handle) {
    setConfig({ ...config, handles: config.handles.filter(h => h !== handle) });
  }

  // Login form
  if (auth.checked && !auth.authenticated) {
    return (
      <div style={styles.container}>
        <h1 style={styles.title}>🐦 Tweet Watcher</h1>
        
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Sign In</h2>
          
          {loginError && (
            <div style={{ ...styles.message, backgroundColor: '#7f1d1d', borderColor: '#dc2626' }}>
              {loginError}
            </div>
          )}
          
          <form onSubmit={handleLogin}>
            <input
              type="text"
              value={loginForm.username}
              onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
              placeholder="Username"
              style={styles.input}
              autoComplete="username"
            />
            <input
              type="password"
              value={loginForm.password}
              onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
              placeholder="Password"
              style={styles.input}
              autoComplete="current-password"
            />
            <button type="submit" style={styles.saveButton}>
              Sign In
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!auth.checked || loading) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>🐦 Tweet Watcher</h1>
        <div style={styles.userInfo}>
          <span style={styles.username}>{auth.username}</span>
          <button onClick={handleLogout} style={styles.logoutButton}>
            Logout
          </button>
        </div>
      </div>
      
      {message && (
        <div style={{
          ...styles.message,
          backgroundColor: message.type === 'error' ? '#7f1d1d' : '#14532d',
          borderColor: message.type === 'error' ? '#dc2626' : '#22c55e',
        }}>
          {message.text}
        </div>
      )}

      <div style={styles.card}>
        <h2 style={styles.cardTitle}>Webhook URL</h2>
        <input
          type="url"
          value={config.webhookUrl}
          onChange={(e) => setConfig({ ...config, webhookUrl: e.target.value })}
          placeholder="https://your-webhook.com/endpoint"
          style={styles.input}
        />
      </div>

      <div style={styles.card}>
        <h2 style={styles.cardTitle}>X Handles to Monitor</h2>
        
        <div style={styles.handleInput}>
          <input
            type="text"
            value={newHandle}
            onChange={(e) => setNewHandle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addHandle())}
            placeholder="@username"
            style={{ ...styles.input, flex: 1, marginBottom: 0 }}
          />
          <button onClick={addHandle} style={styles.addButton}>
            Add
          </button>
        </div>

        <div style={styles.handles}>
          {config.handles.length === 0 ? (
            <p style={styles.empty}>No handles configured</p>
          ) : (
            config.handles.map((handle) => (
              <div key={handle} style={styles.handle}>
                <span>@{handle}</span>
                <button
                  onClick={() => removeHandle(handle)}
                  style={styles.removeButton}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={styles.card}>
        <h2 style={styles.cardTitle}>Poll Interval</h2>
        <div style={styles.intervalRow}>
          <input
            type="range"
            min="1"
            max="60"
            value={config.pollIntervalMinutes}
            onChange={(e) => setConfig({ ...config, pollIntervalMinutes: parseInt(e.target.value) })}
            style={styles.slider}
          />
          <span style={styles.intervalValue}>
            {config.pollIntervalMinutes} min
          </span>
        </div>
        <p style={styles.hint}>
          Cost estimate: ~${(0.40 * config.handles.length * (60 / config.pollIntervalMinutes) * 24).toFixed(2)}/day for {config.handles.length} handle(s)
        </p>
      </div>

      <div style={styles.actions}>
        <button
          onClick={saveConfig}
          disabled={saving}
          style={styles.saveButton}
        >
          {saving ? 'Saving...' : 'Save & Restart'}
        </button>
        
        <button onClick={triggerPoll} style={styles.pollButton}>
          Poll Now
        </button>
      </div>

      {status && (
        <div style={styles.statusCard}>
          <h3 style={styles.statusTitle}>Status</h3>
          <p><strong>Last poll:</strong> {status.state?.lastPoll || 'Never'}</p>
          <p><strong>Tracking:</strong> {Object.keys(status.state?.lastSeenIds || {}).length} handles</p>
          <p><strong>Next poll:</strong> {status.nextPoll}</p>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    maxWidth: 600,
    margin: '0 auto',
    padding: '40px 20px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 30,
  },
  title: {
    fontSize: 32,
    fontWeight: 700,
    margin: 0,
  },
  userInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  username: {
    color: '#a3a3a3',
    fontSize: 14,
  },
  logoutButton: {
    padding: '8px 16px',
    fontSize: 14,
    backgroundColor: 'transparent',
    border: '1px solid #404040',
    borderRadius: 6,
    color: '#a3a3a3',
    cursor: 'pointer',
  },
  card: {
    backgroundColor: '#171717',
    borderRadius: 12,
    padding: 24,
    marginBottom: 20,
    border: '1px solid #262626',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 600,
    marginTop: 0,
    marginBottom: 16,
    color: '#a3a3a3',
  },
  input: {
    width: '100%',
    padding: '12px 16px',
    fontSize: 16,
    backgroundColor: '#262626',
    border: '1px solid #404040',
    borderRadius: 8,
    color: '#ededed',
    outline: 'none',
    boxSizing: 'border-box',
    marginBottom: 12,
  },
  handleInput: {
    display: 'flex',
    gap: 12,
    marginBottom: 16,
  },
  addButton: {
    padding: '12px 24px',
    fontSize: 16,
    backgroundColor: '#3b82f6',
    border: 'none',
    borderRadius: 8,
    color: 'white',
    cursor: 'pointer',
    fontWeight: 600,
  },
  handles: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  handle: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#262626',
    padding: '8px 12px',
    borderRadius: 20,
    fontSize: 14,
  },
  removeButton: {
    background: 'none',
    border: 'none',
    color: '#ef4444',
    fontSize: 20,
    cursor: 'pointer',
    padding: 0,
    lineHeight: 1,
  },
  empty: {
    color: '#525252',
    fontStyle: 'italic',
    margin: 0,
  },
  intervalRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  slider: {
    flex: 1,
    height: 8,
    accentColor: '#3b82f6',
  },
  intervalValue: {
    fontSize: 18,
    fontWeight: 600,
    minWidth: 70,
    textAlign: 'right',
  },
  hint: {
    fontSize: 13,
    color: '#737373',
    marginTop: 12,
    marginBottom: 0,
  },
  actions: {
    display: 'flex',
    gap: 12,
    marginBottom: 20,
  },
  saveButton: {
    flex: 1,
    padding: '14px 24px',
    fontSize: 16,
    backgroundColor: '#22c55e',
    border: 'none',
    borderRadius: 8,
    color: 'white',
    cursor: 'pointer',
    fontWeight: 600,
  },
  pollButton: {
    padding: '14px 24px',
    fontSize: 16,
    backgroundColor: '#404040',
    border: 'none',
    borderRadius: 8,
    color: 'white',
    cursor: 'pointer',
    fontWeight: 600,
  },
  message: {
    padding: '12px 16px',
    borderRadius: 8,
    marginBottom: 20,
    border: '1px solid',
    fontSize: 14,
  },
  statusCard: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 20,
    border: '1px solid #1e3a5f',
    fontSize: 14,
  },
  statusTitle: {
    marginTop: 0,
    marginBottom: 12,
    fontSize: 14,
    color: '#60a5fa',
  },
};
