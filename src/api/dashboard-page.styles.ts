export const DASHBOARD_STYLES = String.raw`  :root {
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
`;
