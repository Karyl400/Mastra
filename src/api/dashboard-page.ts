import { DASHBOARD_STYLES } from './dashboard-page.styles';
import { DASHBOARD_SCRIPT } from './dashboard-page.script';

export const DASHBOARD_PAGE = String.raw`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Marcel — activité en direct</title>
<style>
${DASHBOARD_STYLES}</style>
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
${DASHBOARD_SCRIPT}</script>
</body>
</html>`;
