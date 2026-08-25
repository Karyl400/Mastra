export const DASHBOARD_PAGE = String.raw`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Marcel — activité en direct</title>
<style>
  :root {
    --ink: #101418; --paper: #f6f5f2; --slate: #616c6b;
    --verified: #0e6b57; --claimed: #a33420; --rule: rgba(16,20,24,.13);
    --raise: rgba(14,107,87,.06);
    --serif: Georgia, "Iowan Old Style", "Palatino Linotype", ui-serif, serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #e8e6e1; --paper: #0e1214; --slate: #8f9b98;
      --verified: #4fbfa2; --claimed: #e0765c; --rule: rgba(232,230,225,.16);
      --raise: rgba(79,191,162,.08);
    }
  }
  :root[data-theme="dark"] {
    --ink: #e8e6e1; --paper: #0e1214; --slate: #8f9b98;
    --verified: #4fbfa2; --claimed: #e0765c; --rule: rgba(232,230,225,.16);
    --raise: rgba(79,191,162,.08);
  }
  :root[data-theme="light"] {
    --ink: #101418; --paper: #f6f5f2; --slate: #616c6b;
    --verified: #0e6b57; --claimed: #a33420; --rule: rgba(16,20,24,.13);
    --raise: rgba(14,107,87,.06);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.4rem 1.2rem 5rem;
    background: var(--paper); color: var(--ink);
    font-family: var(--serif); font-size: 17px; line-height: 1.55;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 62rem; margin: 0 auto; }

  header { border-bottom: 1px solid var(--rule); padding-bottom: 1.2rem; margin-bottom: 1.6rem; }
  h1 { font-size: 1.65rem; margin: 0 0 .35rem; letter-spacing: -.01em; font-weight: 600; }
  .rail { font-family: var(--mono); font-size: .74rem; color: var(--slate); letter-spacing: .04em; }
  .lede { color: var(--slate); margin: .7rem 0 0; font-size: .95rem; max-width: 46rem; }

  .bar { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-top: 1.1rem; }
  button, input {
    font-family: var(--mono); font-size: .76rem; color: var(--ink);
    background: transparent; border: 1px solid var(--rule);
    border-radius: 3px; padding: .38rem .7rem; cursor: pointer;
  }
  input { cursor: text; min-width: 15rem; flex: 1 1 15rem; }
  button:hover { border-color: var(--verified); color: var(--verified); }
  .state { font-family: var(--mono); font-size: .72rem; color: var(--slate); }
  .state.live { color: var(--verified); }
  .state.bad { color: var(--claimed); }

  h2 {
    font-size: .78rem; font-family: var(--mono); font-weight: 600;
    letter-spacing: .1em; text-transform: uppercase; color: var(--slate);
    margin: 2.6rem 0 .2rem; padding-bottom: .5rem; border-bottom: 1px solid var(--rule);
  }
  .why { color: var(--slate); font-size: .9rem; margin: .7rem 0 1.1rem; max-width: 46rem; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: .9rem; }
  .card {
    border: 1px solid var(--rule); border-radius: 4px; padding: .85rem .95rem;
    background: var(--raise);
  }
  .card.gap { background: transparent; border-style: dashed; }
  .card .label { font-size: .82rem; color: var(--slate); margin-bottom: .35rem; }
  .card .value { font-family: var(--mono); font-size: 1.7rem; letter-spacing: -.02em; }
  .card .value.none { font-size: 1rem; color: var(--claimed); line-height: 1.35; }
  .card .value.none.soft { color: var(--slate); }
  .card .detail { font-family: var(--mono); font-size: .68rem; color: var(--slate); margin-top: .3rem; word-break: break-word; }
  .card .detail.warn { color: var(--claimed); }
  .card .src { font-family: var(--mono); font-size: .64rem; color: var(--slate); margin-top: .5rem; opacity: .8; word-break: break-word; }
  .card .because { font-size: .78rem; color: var(--slate); margin-top: .45rem; }
  .card .because b { color: var(--ink); font-weight: 600; }

  .feed { border: 1px solid var(--rule); border-radius: 4px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-family: var(--mono); font-size: .72rem; }
  th, td { text-align: left; padding: .4rem .7rem; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  th { color: var(--slate); font-weight: 600; letter-spacing: .05em; }
  tr:last-child td { border-bottom: 0; }
  td.role-user { color: var(--verified); }
  td.role-assistant { color: var(--slate); }

  .note {
    border-left: 2px solid var(--claimed); padding: .1rem 0 .1rem .9rem;
    margin: 1.4rem 0; color: var(--slate); font-size: .9rem;
  }
  .note b { color: var(--ink); }
  footer { margin-top: 3.5rem; padding-top: 1.2rem; border-top: 1px solid var(--rule);
           color: var(--slate); font-size: .82rem; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="rail" id="rail">EN ATTENTE DU JETON</div>
    <h1>Marcel — activité sur la plateforme</h1>
    <p class="lede">
      Lecture seule, <b>zéro token de modèle</b> : chaque chiffre sort d'une requête SQL. Une
      mesure que ce produit ne sait pas faire n'affiche pas <span class="rail">0</span> — elle dit
      pourquoi elle est absente, et ce qu'il faudrait pour l'obtenir.
    </p>
    <div class="bar">
      <input id="token" type="password" placeholder="Jeton du tableau de bord" autocomplete="off" />
      <button id="go">Ouvrir</button>
      <button id="pause">Pause</button>
      <button id="theme">Thème</button>
      <span class="state" id="state">—</span>
    </div>
  </header>

  <main id="main"></main>

  <footer>
    Fenêtre glissante de <span id="win">24</span> h pour l'activité, <span id="livewin">60</span> min
    pour le direct — c'est <span class="rail">CONVERSATION_TTL_MS</span>, le même TTL qui gouverne
    déjà la mémoire et le routage collant. Rafraîchissement toutes les 15 s.
  </footer>
</div>

<script>
(function () {
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
    no_data_yet: 'Rien encore — le produit sait mesurer ceci'
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
      + '<div class="value none' + (r.gap === 'no_data_yet' ? ' soft' : '') + '">'
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
</script>
</body>
</html>`;
