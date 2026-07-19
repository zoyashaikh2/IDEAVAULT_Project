/**
 * Venture Intelligence Shared Logic
 */

(function(global) {
  const API = window.location.origin + '/api';

  global.matchInvestors = async function(id) {
    try {
      if (typeof window.__ivToast === 'function') window.__ivToast("Searching for top VC matches...");
      const res = await fetch(API + '/investors/match/' + id);
      const matches = await res.json();
      if (!matches || !matches.length) {
        alert("No suitable VCs found for this sector yet.");
        return;
      }
      const top = matches[0];
      
      // If we are on dashboard, we might want to update local state, but let's just show the result for now
      // and let the user refresh or rely on Socket.io
      alert("Top Match Found: " + top.investor.name + " (" + top.matchScore + "% fit)\n\n" + top.investor.description);
      
      // Emit event for dashboard to refresh if needed
      document.dispatchEvent(new CustomEvent('ideavault:refresh'));
    } catch (e) { console.error(e); }
  };

  global.buildSimilarStartup = function (ideaJson) {
    try {
      if (
        ideaJson &&
        String(ideaJson).length === 24 &&
        /^[a-f0-9]+$/i.test(String(ideaJson)) &&
        global.IdeaVaultContact &&
        global.IdeaVaultContact.runBuildSimilarById
      ) {
        global.IdeaVaultContact.runBuildSimilarById(String(ideaJson));
        return;
      }
      const idea = JSON.parse(ideaJson);
      localStorage.setItem(
        'iv_draft_copy',
        JSON.stringify({
          title: 'Inspired by ' + idea.title,
          category: idea.category,
          problem: idea.problem,
          solution: 'A new take on ' + idea.solution,
          tags: idea.tags,
          idealCustomer: idea.idealCustomer,
        }),
      );
      window.location.href = '/create-idea.html?fromInspired=1';
    } catch (e) {
      console.error(e);
    }
  };

  global.initiateFundraise = function(ideaId) {
    window.location.href = '/raise-funds.html?ideaId=' + ideaId;
  };

})(window);
