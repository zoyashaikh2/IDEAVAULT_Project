/**
 * USD ↔ INR display (rate from GET /api/config or default 83).
 */
(function (g) {
  g.IV_USD_TO_INR = 83;

  g.ivSetInrRate = function (n) {
    var v = Number(n);
    if (!Number.isNaN(v) && v > 0) g.IV_USD_TO_INR = v;
  };

  g.ivUsdToInr = function (usd) {
    var u = Number(usd) || 0;
    return Math.round(u * g.IV_USD_TO_INR);
  };

  g.ivFormatUsdInr = function (usd) {
    var inr = g.ivUsdToInr(usd);
    var u = Number(usd) || 0;
    return (
      '₹' +
      inr.toLocaleString('en-IN', { maximumFractionDigits: 0 }) +
      ' (~$' +
      u.toLocaleString('en-US', { maximumFractionDigits: 0 }) +
      ')'
    );
  };

  g.ivFetchMoneyConfig = function (apiBase) {
    var base = apiBase || (typeof API !== 'undefined' ? API : window.location.origin + '/api');
    return fetch(String(base).replace(/\/?$/, '') + '/config')
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d && d.usdToInr) g.ivSetInrRate(d.usdToInr);
      })
      .catch(function () {});
  };
})(typeof window !== 'undefined' ? window : globalThis);
