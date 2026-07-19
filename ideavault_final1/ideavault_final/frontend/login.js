const API = window.location.origin + '/api';

(function () {
  var magicPanel = document.getElementById('panel-magic');
  var passPanel = document.getElementById('panel-pass');
  var toggle = document.getElementById('toggle-mode');
  var useMagic = true;
  var msg = document.getElementById('msg');

  function setMsg(text, cls) {
    msg.textContent = text || '';
    msg.className = 'auth-msg' + (cls ? ' ' + cls : '');
  }

  function switchMode() {
    useMagic = !useMagic;
    if (useMagic) {
      magicPanel.hidden = false;
      passPanel.hidden = true;
      toggle.textContent = 'Use Password Instead';
    } else {
      magicPanel.hidden = true;
      passPanel.hidden = false;
      toggle.textContent = 'Use Magic Link Instead';
    }
    setMsg('');
  }

  toggle.addEventListener('click', switchMode);

  document.getElementById('btn-magic').addEventListener('click', async function () {
    var email = document.getElementById('magic-email').value.trim();
    if (!email) {
      setMsg('Please enter your email.', 'error');
      return;
    }
    setMsg('Sending…', 'info');
    try {
      var res = await fetch(API + '/send-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setMsg('Check your email for a sign-in link.', 'success');
    } catch (e) {
      setMsg(e.message || 'Could not send link.', 'error');
    }
  });

  document.getElementById('btn-login').addEventListener('click', async function () {
    var email = document.getElementById('pass-email').value.trim();
    var password = document.getElementById('pass-password').value;
    if (!email || !password) {
      setMsg('Email and password are required.', 'error');
      return;
    }
    setMsg('Signing in…', 'info');
    try {
      var res = await fetch(API + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (res.status === 403 && data.needsVerification) {
        setMsg(
          'Please verify your email first. Check your inbox for the magic link, or register again.',
          'error',
        );
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Login failed');
      localStorage.setItem('ideavault_userId', data.user._id);
      if (data.token) localStorage.setItem('ideavault_token', data.token);
      setMsg('Welcome back! Redirecting…', 'success');
      setTimeout(function () {
        window.location.href = '/dashboard.html';
      }, 500);
    } catch (e) {
      setMsg(e.message || 'Login failed.', 'error');
    }
  });
})();
