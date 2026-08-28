export const DASHBOARD_SCRIPT = String.raw`(function () {
  var FAMILIES = [
    ['onboarding', 'Progression et complétion',
     "L'entonnoir révèle où les gens s'arrêtent. ⚠️ Celui demandé — « par étape d'onboarding » — n'existe pas : le suivi de tâches a été supprimé le 2026-08-14 et il ne reste qu'une étape. Ce qu'on montre est l'entonnoir réel du produit, de la présence dans le workspace à l'entretien rempli."],
    ['engagement', 'Engagement des utilisateurs',
     "Un faible taux de réponse signale un manque de clarté. À lire avec sa réserve : on mesure une CONTINUATION, et quelqu'un qui obtient sa réponse du premier coup et s'arrête compte comme n'ayant pas répondu."],
    ['ai', "Performance de l'IA",
     "Ce que ce produit peut dire de lui-même, et ce qu'il ne peut pas. La part des réponses sans modèle est une estimation dont la formule est affichée ; la latence et les réponses requalifiées sont mesurées à l'exécution puis jetées."],
    ['health', 'Santé technique',
     "Au-delà d'une dizaine de secondes, la lenteur devient une mauvaise impression. La latence n'est pas ici : elle est mesurée à chaque run et n'est écrite dans aucune table."],
    ['satisfaction', 'Satisfaction et feedback',
     "Aucune de ces trois mesures n'a de source, et c'est le cas où afficher un zéro serait le plus coûteux : personne ne vérifie « satisfaction : 0 % » — on en conclut que les gens sont mécontents, pas que la question n'a jamais été posée."],
    ['live', 'Activité en temps réel',
     "Suivre une cohorte, repérer un pic, voir un fil s'ouvrir. Le flux ne transporte AUCUN contenu de message : horodatage, rôle, agent, longueur, empreinte de la conversation."]
  ];

  var GAPS = {
    no_mechanism: 'Le produit n’a pas cette fonction',
    not_persisted: 'Mesuré à l’exécution, écrit nulle part',
    no_events: 'L’abonnement Slack manque',
    external_owner: 'La mesure appartient à la plateforme',
    read_failed: 'Table illisible sur cette base',
    no_data_yet: 'Rien encore — le produit sait mesurer ceci',
    not_comparable: 'Compteurs de durées de vie différentes'
  };

  var UNITS = { percent: ' %', minutes: ' min', ms: ' ms', count: '' };

  var $ = function (id) { return document.getElementById(id); };
  var timer = null, paused = false;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function card(m) {
    var r = m.reading;
    if (r.available) {
      var warn = r.detail && r.detail.indexOf('incohérent') >= 0;
      var src = m.source.from.join(' · ') + (m.source.caveat ? ' — ' + m.source.caveat : '');
      return '<div class="card">'
        + '<div class="label">' + esc(m.label) + '</div>'
        + '<div class="value">' + esc(r.value) + (UNITS[m.unit] || '') + '</div>'
        + (r.detail ? '<div class="detail' + (warn ? ' warn' : '') + '">' + esc(r.detail) + '</div>' : '')
        + '<div class="src">' + esc(src) + '</div>'
        + '</div>';
    }
    var s = m.source;
    return '<div class="card gap">'
      + '<div class="label">' + esc(m.label) + '</div>'
      + '<div class="value none' + (r.gap === 'no_data_yet' || r.gap === 'not_comparable' ? ' soft' : '') + '">'
          + esc(GAPS[r.gap] || r.gap) + '</div>'
      + (s.derived ? '' : '<div class="because">' + esc(s.because)
          + '<br /><br /><b>Ce qu’il faudrait :</b> ' + esc(s.wouldTake) + '</div>')
      + '</div>';
  }

  function feedTable(feed) {
    if (!feed.length) return '<p class="why">Aucun tour dans la fenêtre.</p>';
    var rows = feed.map(function (e) {
      var d = new Date(e.at);
      return '<tr><td>' + esc(d.toISOString().slice(11, 19)) + '</td>'
        + '<td class="role-' + esc(e.kind) + '">' + esc(e.kind) + '</td>'
        + '<td>' + esc(e.agentId || '—') + '</td>'
        + '<td>' + esc(e.conversationRef) + '</td>'
        + '<td>' + esc(e.length) + ' car.</td></tr>';
    }).join('');
    return '<div class="feed"><table><thead><tr>'
      + '<th>heure (UTC)</th><th>rôle</th><th>agent</th><th>fil</th><th>taille</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function render(data) {
    $('win').textContent = data.windowHours;
    $('livewin').textContent = data.liveWindowMinutes;
    $('rail').textContent = 'INSTANTANÉ ' + data.at.slice(0, 19).replace('T', ' ') + ' UTC';

    var html = '';

    if (data.unreadableTables.length) {
      html += '<p class="note"><b>Tables illisibles sur cette base :</b> '
        + esc(data.unreadableTables.join(', '))
        + '. Les métriques qui en dépendent sont marquées indisponibles ; les autres sont intactes.</p>';
    }

    FAMILIES.forEach(function (f) {
      var metrics = data.metrics.filter(function (m) { return m.family === f[0]; });
      if (!metrics.length) return;
      html += '<h2>' + esc(f[1]) + '</h2><p class="why">' + f[2] + '</p>';
      html += '<div class="grid">' + metrics.map(card).join('') + '</div>';
      if (f[0] === 'live') {
        html += '<p class="why">Le flux ci-dessous n’a <b>aucune borne de temps</b>, à la '
          + 'différence des compteurs : ce sont les derniers tours enregistrés, même anciens. '
          + 'Aucun contenu de message n’y figure.</p>'
          + feedTable(data.feed);
      }
    });

    $('main').innerHTML = html;
  }

  function poll() {
    var token = sessionStorage.getItem('marcel.dashboard');
    if (!token) { $('state').textContent = 'jeton requis'; $('state').className = 'state'; return; }

    fetch('/dashboard/metrics', { headers: { authorization: 'Bearer ' + token } })
      .then(function (res) { return res.json().then(function (b) { return { s: res.status, b: b }; }); })
      .then(function (out) {
        if (out.s === 503 && out.b.reason === 'dashboard_token_not_configured') {
          $('state').className = 'state bad';
          $('state').textContent = 'DASHBOARD_TOKEN non posé — la route refuse de servir';
          return;
        }
        if (!out.b.ok) {
          $('state').className = 'state bad';
          $('state').textContent = 'refusé : ' + out.b.reason;
          return;
        }
        $('state').className = 'state live';
        $('state').textContent = paused ? 'en pause' : 'en direct';
        render(out.b);
      })
      .catch(function (e) {
        $('state').className = 'state bad';
        $('state').textContent = 'injoignable : ' + e.message;
      });
  }

  function start() {
    if (timer) clearInterval(timer);
    poll();
    if (!paused) timer = setInterval(poll, 15000);
  }

  $('go').onclick = function () {
    var v = $('token').value.trim();
    if (v) sessionStorage.setItem('marcel.dashboard', v);
    $('token').value = '';
    start();
  };
  $('pause').onclick = function () {
    paused = !paused;
    $('pause').textContent = paused ? 'Reprendre' : 'Pause';
    start();
  };
  $('theme').onclick = function () {
    var root = document.documentElement;
    var dark = root.getAttribute('data-theme') === 'dark'
      || (!root.getAttribute('data-theme')
          && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.setAttribute('data-theme', dark ? 'light' : 'dark');
  };
  $('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('go').click(); });

  if (sessionStorage.getItem('marcel.dashboard')) start();
})();
`;
