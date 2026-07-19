/**
 * Unified "Contact creator" UX: choose Email (mailto / Gmail compose) or Call (tel:).
 * Also handles AI "Build similar" via POST /api/ai/build-similar (cached server-side).
 */
(function (global) {
  var API = global.__IV_API__ || window.location.origin + '/api';

  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function ensureBackdrop() {
    var id = 'iv-contact-modal-root';
    var el = document.getElementById(id);
    if (el) return el;
    el = document.createElement('div');
    el.id = id;
    el.className = 'iv-popup-backdrop';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<div class="iv-popup" role="dialog" aria-modal="true" style="max-width:440px">' +
      '<button type="button" class="iv-popup-close" data-iv-cm-close aria-label="Close">✕</button>' +
      '<h3 style="margin:0 0 12px;font-size:1.1rem"><i class="fa-solid fa-paper-plane" style="color:var(--accent)"></i> Reach Creator / VC</h3>' +
      '<p class="iv-strat-muted" style="margin:0 0 14px;font-size:0.88rem;line-height:1.5">Compose a custom message for <strong data-iv-cm-name style="color:var(--text)"></strong> regarding <em data-iv-cm-title style="color:var(--text)"></em>.</p>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
      '<label class="iv-label" style="margin:0;">Subject' +
      '<input class="iv-input" style="font-size:0.85rem;margin-top:4px;" data-iv-cm-subject type="text" />' +
      '</label>' +
      '<label class="iv-label" style="margin:0;">Message' +
      '<textarea class="iv-input" style="height:110px;font-size:0.85rem;margin-top:4px;resize:vertical;" data-iv-cm-message></textarea>' +
      '</label>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px;">' +
      '<a class="iv-btn iv-btn-secondary iv-btn-sm" data-iv-cm-email href="#" rel="noopener"><i class="fa-regular fa-envelope"></i> Open Mail Client</a>' +
      '<button type="button" class="iv-btn iv-btn-primary iv-btn-sm" data-iv-cm-send-node><i class="fa-solid fa-circle-nodes"></i> Direct Send (Nodemailer)</button>' +
      '</div>' +
      '<a class="iv-btn iv-btn-ghost iv-btn-sm iv-btn-block" data-iv-cm-call href="#" style="display:none"><i class="fa-solid fa-phone"></i> Call Phone</a>' +
      '<p data-iv-cm-no-email style="display:none;font-size:0.82rem;color:var(--danger);margin:0;text-align:center;">No email is listed on file.</p>' +
      '<p data-iv-cm-status style="display:none;font-size:0.82rem;margin:4px 0 0;text-align:center;font-weight:600;"></p>' +
      '</div></div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      if (e.target === el) closeModal();
    });
    el.querySelector('[data-iv-cm-close]').addEventListener('click', closeModal);
    return el;
  }

  function closeModal() {
    var el = document.getElementById('iv-contact-modal-root');
    if (el) el.classList.remove('is-open');
  }

  function buildMailto(to, subject, body) {
    if (!to || !String(to).trim()) return '#';
    var t = String(to).trim();
    return 'mailto:' + encodeURIComponent(t).replace(/%40/g, '@') + '?subject=' + encodeURIComponent(subject || '') + '&body=' + encodeURIComponent(body || '');
  }

  function buildGmailCompose(to, subject, body) {
    var q =
      'https://mail.google.com/mail/?view=cm&fs=1&to=' +
      encodeURIComponent(to || '') +
      '&su=' +
      encodeURIComponent(subject || '') +
      '&body=' +
      encodeURIComponent(body || '');
    return q;
  }

  function openModal(opts) {
    opts = opts || {};
    var el = ensureBackdrop();
    var name = opts.creatorName || opts.name || 'the creator';
    var title = opts.ideaTitle || opts.title || 'this startup';
    var email = opts.email || '';
    var ideaId = opts.ideaId || '';
    el.querySelector('[data-iv-cm-name]').textContent = name;
    el.querySelector('[data-iv-cm-title]').textContent = title;

    var defaultSubj = opts.subject || 'IdeaVault Outreach — ' + title;
    var defaultBody =
      opts.body ||
      'Hi ' +
      name +
      ',\n\nI found your venture "' +
      title +
      '" on IdeaVault and would love to connect about potential collaboration and investment opportunities.\n\nBest regards';

    var subInput = el.querySelector('[data-iv-cm-subject]');
    var msgText = el.querySelector('[data-iv-cm-message]');
    subInput.value = defaultSubj;
    msgText.value = defaultBody;

    var emailA = el.querySelector('[data-iv-cm-email]');
    var callA = el.querySelector('[data-iv-cm-call]');
    var sendBtn = el.querySelector('[data-iv-cm-send-node]');
    var noE = el.querySelector('[data-iv-cm-no-email]');
    var statusP = el.querySelector('[data-iv-cm-status]');

    statusP.style.display = 'none';
    statusP.textContent = '';

    if (email && String(email).trim()) {
      noE.style.display = 'none';
      emailA.style.display = '';
      sendBtn.style.display = '';

      emailA.onclick = function (e) {
        e.preventDefault();
        var subj = subInput.value;
        var body = msgText.value;
        var gmailUrl = buildGmailCompose(email, subj, body);
        window.open(gmailUrl, '_blank', 'noopener,noreferrer');
        closeModal();
      };

      sendBtn.onclick = function (e) {
        e.preventDefault();
        var tok = localStorage.getItem('ideavault_token') || '';
        if (!tok) {
          statusP.style.color = 'var(--danger)';
          statusP.textContent = 'Please log in to send emails.';
          statusP.style.display = '';
          return;
        }

        statusP.style.color = 'var(--accent)';
        statusP.textContent = 'Sending email via Nodemailer...';
        statusP.style.display = '';
        sendBtn.disabled = true;

        fetch(API + '/contact/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
          body: JSON.stringify({
            ideaId: ideaId || null,
            targetEmail: email,
            subject: subInput.value,
            message: msgText.value
          })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            sendBtn.disabled = false;
            if (d.error) {
              statusP.style.color = 'var(--danger)';
              statusP.textContent = d.error;
            } else {
              statusP.style.color = '#10b981';
              statusP.textContent = 'Email sent successfully via Nodemailer!';
              if (typeof global.ivToast === 'function') {
                global.ivToast('Email sent securely via Nodemailer!', 'success');
              }
              setTimeout(closeModal, 1500);
            }
          })
          .catch(function () {
            sendBtn.disabled = false;
            statusP.style.color = 'var(--danger)';
            statusP.textContent = 'Failed to send. Check backend SMTP configuration.';
          });
      };

    } else {
      emailA.style.display = 'none';
      sendBtn.style.display = 'none';
      noE.style.display = '';
    }

    var phone = opts.phone || '';
    if (phone && String(phone).trim()) {
      var tel = 'tel:' + String(phone).replace(/\s+/g, '');
      callA.href = tel;
      callA.style.display = '';
    } else {
      callA.style.display = 'none';
    }

    el.classList.add('is-open');
  }

  function openFromIdea(idea) {
    if (!idea) return;
    openModal({
      ideaId: idea._id,
      email: idea.email,
      phone: idea.phone,
      creatorName: idea.name,
      ideaTitle: idea.title,
    });
  }

  function wireContactButtons(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-iv-contact-payload]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        try {
          var raw = btn.getAttribute('data-iv-contact-payload');
          var o = JSON.parse(decodeURIComponent(raw));
          openModal(o);
        } catch (err) {
          console.error(err);
        }
      });
    });
  }

  function contactPayloadAttr(idea) {
    var o = {
      ideaId: idea._id || '',
      email: idea.email || '',
      phone: idea.phone || '',
      creatorName: idea.name || 'Founder',
      ideaTitle: idea.title || 'Startup idea',
    };
    return encodeURIComponent(JSON.stringify(o));
  }

  function stratContactButtonHtml(idea) {
    return (
      '<div class="strat-block strat-contact-wrap">' +
      '<h4><i class="fa-solid fa-address-card"></i> Contact creator</h4>' +
      '<p class="iv-strat-muted" style="font-size:0.85rem">Email opens your mail client with the founder as recipient. Call uses your device dialer when a phone is listed.</p>' +
      '<button type="button" class="iv-btn iv-btn-primary iv-btn-sm" data-iv-contact-payload="' +
      contactPayloadAttr(idea) +
      '"><i class="fa-solid fa-paper-plane"></i> Contact creator</button></div>'
    );
  }

  async function runBuildSimilarById(ideaId) {
    var tok = localStorage.getItem('ideavault_token') || '';
    if (!tok) {
      alert('Sign in to use Build Similar with AI.');
      return;
    }
    if (typeof global.ivToast === 'function') global.ivToast('Generating a sibling concept with AI…', 'info', 5000);
    try {
      var res = await fetch(API + '/ai/build-similar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ ideaId: String(ideaId) }),
      });
      var data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'AI request failed');
      localStorage.setItem(
        'iv_draft_copy',
        JSON.stringify({
          title: data.title || 'New venture',
          category: data.category || '',
          problem: data.problem || '',
          solution: data.solution || '',
          tags: data.tags || [],
          idealCustomer: data.idealCustomer || '',
          summary: data.oneLineSummary || data.summary || '',
        }),
      );
      if (typeof global.ivToast === 'function') global.ivToast('Opening editor with AI draft…', 'success', 2500);
      window.location.href = '/create-idea.html?fromInspired=1';
    } catch (e) {
      console.error(e);
      alert(e.message || 'Build Similar failed. Check GROQ_API_KEY in server .env.');
    }
  }

  global.IdeaVaultContact = {
    openModal: openModal,
    openFromIdea: openFromIdea,
    wireContactButtons: wireContactButtons,
    stratContactButtonHtml: stratContactButtonHtml,
    contactPayloadAttr: contactPayloadAttr,
    runBuildSimilarById: runBuildSimilarById,
    closeModal: closeModal,
  };
})(typeof window !== 'undefined' ? window : globalThis);
