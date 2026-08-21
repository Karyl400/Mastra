/**
 * ════════════════════════════════════════════════════════════════════════════
 * DEUX RÉSOLVEURS DE PERSONNE, ZÉRO GARDE — et ils rendaient la CLÉ
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Recensement de l'audit du 2026-08-21 : sur treize outils, dix consultent une garde
 * d'autorisation. Les trois qui n'en consultent aucune sont `findPersonByName`,
 * `findEmployeeByEmail` et `findExpertise`.
 *
 * Le cas de `findExpertise` est défendable et documenté : il ne rend que des NOMS, jamais un
 * identifiant ni une adresse. Les deux autres rendaient **l'UUID interne**, le poste et le
 * statut de n'importe qui, à n'importe qui — invité mono-canal compris, depuis n'importe quel
 * message Slack.
 *
 * ⚠️ **CE QU'ON NE FAIT PAS : bloquer.** La contrepartie est réelle et écrite noir sur blanc
 * dans ce dépôt — « un agent qui ne sait pas résoudre une personne ne peut RIEN faire », et le
 * câblage manquant a déjà produit une boucle sans sortie le 2026-08-10. Une garde bloquante
 * casserait le produit pour fermer une fuite modeste.
 *
 * **CE QU'ON FAIT : réduire.** L'UUID est la CLÉ — c'est lui qui rend l'appel suivant possible.
 * Un demandeur non autorisé garde de quoi poursuivre le dialogue (le nom) et perd de quoi agir.
 * Il ne perd d'ailleurs rien d'utile : `getEmployeeProfile`, `generateDocument`,
 * `sendNotification` et `scheduleReminder` lui refuseraient déjà cet identifiant.
 *
 * ⚠️ **L'ANTI-ORACLE compte autant que la réduction.** `findEmployeeByEmail` répondait
 * `found: true/false` sur une adresse arbitraire : c'est l'énumération d'annuaire une adresse à
 * la fois, exactement ce que `getEmployeeProfile` a été retravaillé pour ne pas être (« il
 * passe l'identifiant RÉSOLU **ou `null`**, si bien qu'un demandeur non autorisé reçoit le MÊME
 * verdict que l'adresse désigne quelqu'un ou personne »). La même précaution n'avait pas été
 * portée ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { makeFindPersonByName } from '../../../src/features/employee/application/tools/find-person-by-name';
import { makeFindEmployeeByEmail } from '../../../src/features/employee/application/tools/find-employee-by-email';
import { buildSlackRequestContext } from '../../../src/shared/slack-request-context';

const AWA_ID = '11111111-1111-4111-8111-111111111111';
const KARYL_ID = '22222222-2222-4222-8222-222222222222';

const AWA = {
  id: AWA_ID,
  firstName: 'Awa',
  lastName: 'TRAORE',
  email: 'awa@kissohq.com',
  position: 'Backend Developer',
  status: 'active',
};

function repo() {
  return {
    findByName: async (q: string) => (q.toLowerCase().includes('awa') ? [AWA] : []),
    findByEmail: async (e: string) => (e === AWA.email ? AWA : null),
    findById: async (id: string) => (id === AWA_ID ? AWA : null),
  };
}

/** Le demandeur, tel que le handler Slack le pose — jamais tel que le modèle le déclare. */
function asker(employeeId: string | undefined, accessLevel: 'full' | 'readonly') {
  return {
    requestContext: buildSlackRequestContext({
      channel: 'D0X',
      slackUserId: 'U0X',
      ...(employeeId ? { employeeId } : {}),
      accessLevel,
    }),
  };
}

describe('findPersonByName — la clé ne sort que pour qui peut s’en servir', () => {
  let tool: ReturnType<typeof makeFindPersonByName>;
  beforeEach(() => {
    tool = makeFindPersonByName(repo() as never);
  });

  async function run(ctx: unknown) {
    return (await tool.execute!({ name: 'Awa' } as never, ctx as never)) as Record<string, unknown>;
  }

  it('rend TOUT au manager', async () => {
    const result = await run(asker(KARYL_ID, 'full'));
    expect(result.found).toBe(true);
    expect(JSON.stringify(result)).toContain(AWA_ID);
  });

  it('rend tout à la personne elle-même', async () => {
    // La règle de ce dépôt depuis le 2026-08-13 : son propre dossier TOUJOURS, comparé AVANT
    // le niveau. Sans cela `readonly` — le cas nominal de 7 personnes sur 8 — couperait chacun
    // de lui-même.
    const result = await run(asker(AWA_ID, 'readonly'));
    expect(JSON.stringify(result)).toContain(AWA_ID);
  });

  it("retient l'UUID et le statut d'un TIERS pour un demandeur non autorisé", async () => {
    const result = await run(asker(KARYL_ID, 'readonly'));

    // On trouve toujours la personne : le dialogue peut continuer.
    expect(result.found).toBe(true);
    const flat = JSON.stringify(result);
    expect(flat).toContain('Awa');
    // Mais la CLÉ ne sort pas, ni l'état RH.
    expect(flat).not.toContain(AWA_ID);
    expect(flat).not.toContain('active');
  });

  it('RESTE utilisable hors contexte Slack — playground, workflow, test', async () => {
    /**
     * ⚠️ **CETTE ASSERTION A ÉTÉ ÉCRITE À L'ENVERS, PUIS CORRIGÉE.** Sa première version
     * exigeait que la clé soit retenue sans contexte Slack. Elle a cassé 19 tests existants —
     * qui encodaient une décision délibérée : `readSlackContext` rend `undefined` sur ces
     * chemins PAR CONCEPTION, et « au tool de dégrader » est écrit noir sur blanc.
     *
     * Inverser ce fail-open dépassait ce que l'audit demandait, et aurait pu couper la
     * résolution de SOI-MÊME pendant la fenêtre d'accueil, quand `slack_directory.employee_id`
     * n'est pas encore écrite — la famille exacte du défaut du 2026-08-19.
     *
     * Ce qui ferme réellement le risque est `createToolExecutionGuard` : les routes
     * `/api/**` d'exécution d'outil, seule porte de production sans contexte Slack, sont
     * refusées en 403. On ferme la route, pas la règle.
     */
    const result = (await tool.execute!({ name: 'Awa' } as never, {} as never)) as Record<
      string,
      unknown
    >;
    expect(result.found).toBe(true);
    expect(JSON.stringify(result)).toContain(AWA_ID);
  });
});

describe('findEmployeeByEmail — pas d’oracle d’énumération', () => {
  let tool: ReturnType<typeof makeFindEmployeeByEmail>;
  beforeEach(() => {
    tool = makeFindEmployeeByEmail(repo() as never);
  });

  async function run(email: string, ctx: unknown) {
    return (await tool.execute!({ email } as never, ctx as never)) as Record<string, unknown>;
  }

  it("rend le MÊME verdict qu'une adresse désigne quelqu'un ou personne", async () => {
    // C'est la propriété qui compte : sans elle, on énumère l'annuaire une adresse à la fois.
    const connue = await run(AWA.email, asker(KARYL_ID, 'readonly'));
    const inconnue = await run('personne@kissohq.com', asker(KARYL_ID, 'readonly'));

    expect(connue.found).toBe(inconnue.found);
    expect(connue.reason).toBe(inconnue.reason);
  });

  it('rend la clé au manager', async () => {
    const result = await run(AWA.email, asker(KARYL_ID, 'full'));
    expect(JSON.stringify(result)).toContain(AWA_ID);
  });

  it('rend la clé à la personne elle-même', async () => {
    const result = await run(AWA.email, asker(AWA_ID, 'readonly'));
    expect(JSON.stringify(result)).toContain(AWA_ID);
  });
});
