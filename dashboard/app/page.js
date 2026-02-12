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
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  
  // Password change
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ current: '', new: '', confirm: '' });
  const [passwordError, setPasswordError] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  // Debounced handle preview
  useEffect(() => {
    if (!newHandle || newHandle.length < 2) {
      setHandlePreview(null);
      return;
    }
    
    const timer = setTimeout(() => {
      fetchHandlePreview(newHandle);
    }, 500);
    
    return () => clearTimeout(timer);
  }, [newHandle]);

  function getToken() {
    if (typeof window === 'undefined') return null;
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

  async function handleChangePassword(e) {
    e.preventDefault();
    setPasswordError('');
    
    if (passwordForm.new !== passwordForm.confirm) {
      setPasswordError('Passwords do not match');
      return;
    }
    
    if (passwordForm.new.length < 4) {
      setPasswordError('Password must be at least 4 characters');
      return;
    }
    
    setChangingPassword(true);
    
    try {
      const res = await fetch(`${API_URL}/auth/password`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({
          currentPassword: passwordForm.current,
          newPassword: passwordForm.new,
        }),
      });
      
      const data = await res.json();
      
      if (data.success) {
        setShowPasswordModal(false);
        setPasswordForm({ current: '', new: '', confirm: '' });
        setMessage({ type: 'success', text: 'Password changed successfully' });
      } else {
        setPasswordError(data.error || 'Failed to change password');
      }
    } catch (err) {
      setPasswordError('Connection error');
    } finally {
      setChangingPassword(false);
    }
  }

  async function fetchHandlePreview(handle) {
    const cleanHandle = handle.replace(/^@/, '').trim();
    if (!cleanHandle) return;
    
    setLoadingPreview(true);
    
    try {
      // Use nitter or another service to check if profile exists
      const res = await fetch(`https://api.twitter.com/2/users/by/username/${cleanHandle}`, {
        headers: { 'Authorization': 'Bearer ' + process.env.NEXT_PUBLIC_TWITTER_BEARER }
      }).catch(() => null);
      
      // Fallback: just show the X link
      setHandlePreview({
        handle: cleanHandle,
        url: `https://x.com/${cleanHandle}`,
        valid: true,
      });
    } catch (err) {
      setHandlePreview({
        handle: cleanHandle,
        url: `https://x.com/${cleanHandle}`,
        valid: true,
      });
    } finally {
      setLoadingPreview(false);
    }
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
        setMessage({ type: 'success', text: 'Configuration saved!' });
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
      setTimeout(fetchStatus, 3000);
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to trigger poll' });
    }
  }

  function addHandle() {
    const handle = newHandle.replace(/^@/, '').trim().toLowerCase();
    if (handle && !config.handles.includes(handle)) {
      setConfig({ ...config, handles: [...config.handles, handle] });
      setNewHandle('');
      setHandlePreview(null);
    }
  }

  function removeHandle(handle) {
    setConfig({ ...config, handles: config.handles.filter(h => h !== handle) });
  }

  // Login form
  if (auth.checked && !auth.authenticated) {
    return (
      <div style={styles.page}>
        <div style={styles.loginContainer}>
          <div style={styles.logoSection}>
            <div style={styles.logo}>🐦</div>
            <h1 style={styles.brandTitle}>Tweet Watcher</h1>
            <p style={styles.brandSubtitle}>Real-time X monitoring</p>
          </div>
          
          <div style={styles.loginCard}>
            <h2 style={styles.loginTitle}>Welcome back</h2>
            
            {loginError && (
              <div style={styles.errorBox}>{loginError}</div>
            )}
            
            <form onSubmit={handleLogin}>
              <div style={styles.inputGroup}>
                <label style={styles.label}>Username</label>
                <input
                  type="text"
                  value={loginForm.username}
                  onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })}
                  style={styles.input}
                  autoComplete="username"
                />
              </div>
              <div style={styles.inputGroup}>
                <label style={styles.label}>Password</label>
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                  style={styles.input}
                  autoComplete="current-password"
                />
              </div>
              <button type="submit" style={styles.primaryButton}>
                Sign In
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (!auth.checked || loading) {
    return (
      <div style={styles.page}>
        <div style={styles.loadingContainer}>
          <div style={styles.spinner}></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.headerLogo}>🐦</span>
          <span style={styles.headerTitle}>Tweet Watcher</span>
        </div>
        <div style={styles.headerRight}>
          <button onClick={() => setShowPasswordModal(true)} style={styles.iconButton} title="Settings">
            ⚙️
          </button>
          <div style={styles.userBadge}>
            <span style={styles.userAvatar}>{auth.username[0].toUpperCase()}</span>
            <span style={styles.userName}>{auth.username}</span>
          </div>
          <button onClick={handleLogout} style={styles.logoutBtn}>
            Logout
          </button>
        </div>
      </header>

      {/* Main content */}
      <main style={styles.main}>
        {message && (
          <div style={{
            ...styles.toast,
            borderColor: message.type === 'error' ? '#ef4444' : '#22c55e',
            background: message.type === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
          }}>
            {message.type === 'error' ? '⚠️' : '✓'} {message.text}
          </div>
        )}

        <div style={styles.grid}>
          {/* Webhook Section */}
          <section style={styles.card}>
            <div style={styles.cardHeader}>
              <h3 style={styles.cardTitle}>
                <span style={styles.cardIcon}>🔗</span>
                Webhook Endpoint
              </h3>
            </div>
            <div style={styles.cardBody}>
              <input
                type="url"
                value={config.webhookUrl}
                onChange={(e) => setConfig({ ...config, webhookUrl: e.target.value })}
                placeholder="https://your-webhook.com/endpoint"
                style={styles.input}
              />
              <p style={styles.hint}>Tweets will be POSTed to this URL as JSON</p>
            </div>
          </section>

          {/* Handles Section */}
          <section style={styles.card}>
            <div style={styles.cardHeader}>
              <h3 style={styles.cardTitle}>
                <span style={styles.cardIcon}>👤</span>
                Monitored Accounts
              </h3>
              <span style={styles.badge}>{config.handles.length}</span>
            </div>
            <div style={styles.cardBody}>
              <div style={styles.handleInputRow}>
                <div style={styles.handleInputWrapper}>
                  <span style={styles.atSymbol}>@</span>
                  <input
                    type="text"
                    value={newHandle}
                    onChange={(e) => setNewHandle(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addHandle())}
                    placeholder="username"
                    style={styles.handleInput}
                  />
                </div>
                <button onClick={addHandle} style={styles.addButton} disabled={!newHandle}>
                  + Add
                </button>
              </div>
              
              {/* Handle Preview */}
              {handlePreview && (
                <div style={styles.previewCard}>
                  <div style={styles.previewInfo}>
                    <span style={styles.previewHandle}>@{handlePreview.handle}</span>
                    <a 
                      href={handlePreview.url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={styles.previewLink}
                    >
                      View on X ↗
                    </a>
                  </div>
                </div>
              )}

              {/* Handle List */}
              <div style={styles.handleList}>
                {config.handles.length === 0 ? (
                  <p style={styles.emptyState}>No accounts added yet</p>
                ) : (
                  config.handles.map((handle) => (
                    <div key={handle} style={styles.handleChip}>
                      <a 
                        href={`https://x.com/${handle}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={styles.handleChipLink}
                      >
                        @{handle}
                      </a>
                      <button
                        onClick={() => removeHandle(handle)}
                        style={styles.removeBtn}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>

          {/* Polling Section */}
          <section style={styles.card}>
            <div style={styles.cardHeader}>
              <h3 style={styles.cardTitle}>
                <span style={styles.cardIcon}>⏱️</span>
                Poll Frequency
              </h3>
              <span style={styles.badgeBlue}>{config.pollIntervalMinutes} min</span>
            </div>
            <div style={styles.cardBody}>
              <input
                type="range"
                min="1"
                max="60"
                value={config.pollIntervalMinutes}
                onChange={(e) => setConfig({ ...config, pollIntervalMinutes: parseInt(e.target.value) })}
                style={styles.slider}
              />
              <div style={styles.sliderLabels}>
                <span>1 min</span>
                <span>30 min</span>
                <span>60 min</span>
              </div>
              <p style={styles.hint}>
                Est. cost: ~${(0.40 * Math.max(1, config.handles.length) * (60 / config.pollIntervalMinutes) * 24).toFixed(2)}/day
              </p>
            </div>
          </section>

          {/* Status Section */}
          {status && (
            <section style={styles.statusCard}>
              <div style={styles.statusHeader}>
                <span style={styles.statusDot}></span>
                System Status
              </div>
              <div style={styles.statusGrid}>
                <div style={styles.statusItem}>
                  <span style={styles.statusLabel}>Tracking</span>
                  <span style={styles.statusValue}>{Object.keys(status.state?.lastSeenIds || {}).length} accounts</span>
                </div>
                <div style={styles.statusItem}>
                  <span style={styles.statusLabel}>Last Poll</span>
                  <span style={styles.statusValue}>
                    {status.state?.lastPoll ? new Date(status.state.lastPoll).toLocaleTimeString() : 'Never'}
                  </span>
                </div>
              </div>
            </section>
          )}
        </div>

        {/* Actions */}
        <div style={styles.actions}>
          <button onClick={triggerPoll} style={styles.secondaryButton}>
            ⚡ Poll Now
          </button>
          <button onClick={saveConfig} disabled={saving} style={styles.primaryButton}>
            {saving ? 'Saving...' : '💾 Save Changes'}
          </button>
        </div>
      </main>

      {/* Password Modal */}
      {showPasswordModal && (
        <div style={styles.modalOverlay} onClick={() => setShowPasswordModal(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <h3 style={styles.modalTitle}>Change Password</h3>
            
            {passwordError && (
              <div style={styles.errorBox}>{passwordError}</div>
            )}
            
            <form onSubmit={handleChangePassword}>
              <div style={styles.inputGroup}>
                <label style={styles.label}>Current Password</label>
                <input
                  type="password"
                  value={passwordForm.current}
                  onChange={(e) => setPasswordForm({ ...passwordForm, current: e.target.value })}
                  style={styles.input}
                />
              </div>
              <div style={styles.inputGroup}>
                <label style={styles.label}>New Password</label>
                <input
                  type="password"
                  value={passwordForm.new}
                  onChange={(e) => setPasswordForm({ ...passwordForm, new: e.target.value })}
                  style={styles.input}
                />
              </div>
              <div style={styles.inputGroup}>
                <label style={styles.label}>Confirm New Password</label>
                <input
                  type="password"
                  value={passwordForm.confirm}
                  onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })}
                  style={styles.input}
                />
              </div>
              <div style={styles.modalActions}>
                <button type="button" onClick={() => setShowPasswordModal(false)} style={styles.secondaryButton}>
                  Cancel
                </button>
                <button type="submit" disabled={changingPassword} style={styles.primaryButton}>
                  {changingPassword ? 'Changing...' : 'Change Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%)',
    color: '#e4e4e7',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  
  // Login styles
  loginContainer: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  logoSection: {
    textAlign: 'center',
    marginBottom: 40,
  },
  logo: {
    fontSize: 64,
    marginBottom: 16,
  },
  brandTitle: {
    fontSize: 32,
    fontWeight: 700,
    margin: 0,
    background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  brandSubtitle: {
    color: '#71717a',
    marginTop: 8,
  },
  loginCard: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 16,
    padding: 32,
    width: '100%',
    maxWidth: 400,
    backdropFilter: 'blur(10px)',
  },
  loginTitle: {
    fontSize: 24,
    fontWeight: 600,
    marginBottom: 24,
    textAlign: 'center',
  },
  
  // Header
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 24px',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
    background: 'rgba(0,0,0,0.3)',
    backdropFilter: 'blur(10px)',
    position: 'sticky',
    top: 0,
    zIndex: 100,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  headerLogo: {
    fontSize: 24,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 600,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  iconButton: {
    background: 'none',
    border: 'none',
    fontSize: 20,
    cursor: 'pointer',
    opacity: 0.7,
    transition: 'opacity 0.2s',
  },
  userBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    background: 'rgba(255,255,255,0.05)',
    borderRadius: 20,
  },
  userAvatar: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 600,
  },
  userName: {
    fontSize: 14,
    color: '#a1a1aa',
  },
  logoutBtn: {
    background: 'none',
    border: '1px solid rgba(255,255,255,0.2)',
    color: '#a1a1aa',
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  },

  // Main
  main: {
    maxWidth: 800,
    margin: '0 auto',
    padding: '32px 24px',
  },
  
  // Toast
  toast: {
    padding: '12px 16px',
    borderRadius: 8,
    marginBottom: 24,
    border: '1px solid',
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  
  // Grid
  grid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  
  // Card
  card: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 16,
    overflow: 'hidden',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: 600,
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  cardIcon: {
    fontSize: 18,
  },
  cardBody: {
    padding: 20,
  },
  badge: {
    background: 'rgba(139,92,246,0.2)',
    color: '#a78bfa',
    padding: '4px 10px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
  },
  badgeBlue: {
    background: 'rgba(59,130,246,0.2)',
    color: '#60a5fa',
    padding: '4px 10px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
  },
  
  // Inputs
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    display: 'block',
    fontSize: 13,
    color: '#71717a',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    padding: '12px 14px',
    fontSize: 14,
    background: 'rgba(0,0,0,0.3)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    color: '#e4e4e7',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s',
  },
  hint: {
    fontSize: 12,
    color: '#52525b',
    marginTop: 8,
    marginBottom: 0,
  },
  
  // Handle input
  handleInputRow: {
    display: 'flex',
    gap: 10,
    marginBottom: 16,
  },
  handleInputWrapper: {
    flex: 1,
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  atSymbol: {
    position: 'absolute',
    left: 14,
    color: '#52525b',
    fontWeight: 500,
  },
  handleInput: {
    width: '100%',
    padding: '12px 14px 12px 28px',
    fontSize: 14,
    background: 'rgba(0,0,0,0.3)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    color: '#e4e4e7',
    outline: 'none',
  },
  addButton: {
    padding: '12px 20px',
    fontSize: 14,
    fontWeight: 500,
    background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
    border: 'none',
    borderRadius: 8,
    color: 'white',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  
  // Preview
  previewCard: {
    background: 'rgba(59,130,246,0.1)',
    border: '1px solid rgba(59,130,246,0.2)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  previewInfo: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  previewHandle: {
    fontWeight: 500,
    color: '#60a5fa',
  },
  previewLink: {
    color: '#3b82f6',
    fontSize: 13,
    textDecoration: 'none',
  },
  
  // Handle list
  handleList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  handleChip: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: 'rgba(255,255,255,0.05)',
    padding: '8px 12px',
    borderRadius: 20,
    fontSize: 14,
  },
  handleChipLink: {
    color: '#e4e4e7',
    textDecoration: 'none',
  },
  removeBtn: {
    background: 'none',
    border: 'none',
    color: '#ef4444',
    fontSize: 18,
    cursor: 'pointer',
    padding: 0,
    lineHeight: 1,
    opacity: 0.7,
  },
  emptyState: {
    color: '#52525b',
    fontStyle: 'italic',
    margin: 0,
    padding: '20px 0',
    textAlign: 'center',
  },
  
  // Slider
  slider: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    appearance: 'none',
    background: 'rgba(255,255,255,0.1)',
    outline: 'none',
    cursor: 'pointer',
  },
  sliderLabels: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 11,
    color: '#52525b',
    marginTop: 8,
  },
  
  // Status
  statusCard: {
    background: 'rgba(34,197,94,0.05)',
    border: '1px solid rgba(34,197,94,0.2)',
    borderRadius: 16,
    padding: 20,
  },
  statusHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 14,
    fontWeight: 500,
    marginBottom: 16,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#22c55e',
    boxShadow: '0 0 8px #22c55e',
  },
  statusGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 16,
  },
  statusItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  statusLabel: {
    fontSize: 12,
    color: '#52525b',
  },
  statusValue: {
    fontSize: 16,
    fontWeight: 500,
  },
  
  // Actions
  actions: {
    display: 'flex',
    gap: 12,
    marginTop: 24,
    justifyContent: 'flex-end',
  },
  primaryButton: {
    padding: '12px 24px',
    fontSize: 14,
    fontWeight: 500,
    background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
    border: 'none',
    borderRadius: 8,
    color: 'white',
    cursor: 'pointer',
  },
  secondaryButton: {
    padding: '12px 24px',
    fontSize: 14,
    fontWeight: 500,
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    color: '#e4e4e7',
    cursor: 'pointer',
  },
  
  // Modal
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: '#1a1a2e',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 600,
    marginBottom: 20,
  },
  modalActions: {
    display: 'flex',
    gap: 12,
    marginTop: 24,
    justifyContent: 'flex-end',
  },
  
  // Error
  errorBox: {
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.3)',
    color: '#fca5a5',
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 13,
    marginBottom: 16,
  },
  
  // Loading
  loadingContainer: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid rgba(255,255,255,0.1)',
    borderTopColor: '#3b82f6',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
};
