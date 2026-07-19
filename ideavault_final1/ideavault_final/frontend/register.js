const API = window.location.origin + '/api';

function calcAge(dobStr) {
  var d = new Date(dobStr);
  if (isNaN(d.getTime())) return 0;
  var today = new Date();
  var age = today.getFullYear() - d.getFullYear();
  var m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age;
}

(function () {
  var form = document.getElementById('reg-form');
  var formCard = document.getElementById('form-card');
  var successCard = document.getElementById('success-card');
  var msg = document.getElementById('reg-msg');

  function setMsg(text, cls) {
    msg.textContent = text || '';
    msg.className = 'auth-msg' + (cls ? ' ' + cls : '');
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    setMsg('');

    var name = document.getElementById('name').value.trim();
    var email = document.getElementById('email').value.trim();
    var phone = document.getElementById('phone').value.trim();
    var dob = document.getElementById('dob').value;
    var password = document.getElementById('password').value;
    var password2 = document.getElementById('password2').value;
    var occupation = document.getElementById('occupation').value.trim();
    var address = document.getElementById('address').value.trim();
    var bio = document.getElementById('bio').value.trim();

    if (!name) return setMsg('Full name is required.', 'error');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return setMsg('Valid email is required.', 'error');
    }
    if (phone && !/^\d{10}$/.test(phone)) {
      return setMsg('Phone must be exactly 10 digits or empty.', 'error');
    }
    if (!dob) return setMsg('Date of birth is required.', 'error');
    if (calcAge(dob) < 18) return setMsg('You must be at least 18 years old.', 'error');
    if (password.length < 8) return setMsg('Password must be at least 8 characters.', 'error');
    if (password !== password2) return setMsg('Passwords do not match.', 'error');

    setMsg('Creating account…', 'info');
    try {
      var res = await fetch(API + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          email: email,
          phone: phone,
          password: password,
          dob: dob,
          occupation: occupation,
          address: address,
          bio: bio,
        }),
      });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) throw new Error(data.error || 'Registration failed');

      formCard.hidden = true;
      successCard.hidden = false;
      document.getElementById('sent-email').textContent = data.email || email;
    } catch (err) {
      setMsg(err.message || 'Something went wrong.', 'error');
    }
  });
})();
