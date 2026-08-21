import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REMINDER_DISPATCH_PATH,
  REMINDER_DISPATCH_SCHEDULE,
} from '../../../src/features/notification/domain/services/reminder-dispatch';

/**
 * ⚠️ **UNE PLANIFICATION ÉCRITE À DEUX ENDROITS FINIT PAR DIRE DEUX CHOSES — et le symptôme
 * n'est pas une erreur.** Si `vercel.json` s'écarte des constantes du domaine, rien ne casse :
 * le rappel part simplement au mauvais moment, et le texte annoncé à la personne (« le lundi
 * au matin ») ne correspond plus à ce qui se passe. Personne ne le verrait.
 *
 * C'est exactement le défaut que `claimed-invariants.test.ts` a été écrit pour attraper, et la
 * même famille que le fuseau lu par DEUX variables divergentes (`RECRUITMENT_TIMEZONE` d'un
 * côté, `DISPLAY_TIMEZONE || RECRUITMENT_TIMEZONE` de l'autre) : poser l'une changeait
 * l'affichage partout SAUF pour les entretiens.
 *
 * `vercel.json` est la SOURCE — c'est elle que la plateforme lit et qu'un humain ouvre.
 * `fix-vercel-output.js` la recopie vers `config.json` au build ; le domaine en tient le miroir
 * dont le code a besoin pour annoncer une date de remise. Ce test verrouille les trois.
 */
const vercelJson = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as {
  crons?: Array<{ path?: string; schedule?: string }>;
};

describe('le cron déclaré à Vercel EST celui que le code croit', () => {
  it('vercel.json déclare bien un cron', () => {
    expect(vercelJson.crons, 'sans cron, aucun rappel ne part jamais').toBeDefined();
    expect(vercelJson.crons!.length).toBeGreaterThan(0);
  });

  it('il pointe vers la route de remise', () => {
    const paths = vercelJson.crons!.map((c) => c.path);
    expect(paths).toContain(REMINDER_DISPATCH_PATH);
  });

  it('son horaire est celui dont le domaine se sert pour annoncer la remise', () => {
    const cron = vercelJson.crons!.find((c) => c.path === REMINDER_DISPATCH_PATH);
    expect(cron?.schedule).toBe(REMINDER_DISPATCH_SCHEDULE);
  });

  it('aucun cron n’est déclaré sous /api — le préfixe est réservé par @mastra/server', () => {
    for (const cron of vercelJson.crons!) {
      expect(cron.path?.startsWith('/api'), cron.path).toBe(false);
    }
  });

  it('aucun cron ne tourne plus d’une fois par jour — le plan Hobby refuse le DÉPLOIEMENT', () => {
    // « Cron expressions that would run more frequently will fail during deployment. »
    // On le constate ici plutôt qu'en poussant.
    for (const cron of vercelJson.crons!) {
      const [minute, hour] = String(cron.schedule).split(' ');
      expect(minute, cron.schedule).not.toBe('*');
      expect(hour, cron.schedule).not.toBe('*');
      expect(minute, cron.schedule).not.toContain('/');
      expect(hour, cron.schedule).not.toContain('/');
    }
  });

  it('la route est bien enregistrée dans server.apiRoutes — sinon c’est du code mort', () => {
    // ⚠️ Un fichier posé dans `src/api/` n'est JAMAIS monté automatiquement. C'était la cause
    // exacte du bot silencieux : `index.ts` n'avait aucun bloc `server`, donc 404.
    const index = readFileSync(resolve(process.cwd(), 'src/mastra/index.ts'), 'utf8');
    expect(index).toContain('remindersDispatchRoute');
    const apiRoutes = index.slice(index.indexOf('apiRoutes: ['));
    expect(apiRoutes.slice(0, apiRoutes.indexOf(']'))).toContain('remindersDispatchRoute');
  });

  it('le build CONTRÔLE les crons sans en tenir une seconde copie', () => {
    // ⚠️ La première version les RECOPIAIT dans `.vercel/output/config.json`, sur la foi de la
    // doc du Build Output API. Le déploiement a échoué : « A duplicated cron job with the same
    // schedule and path was found ». Vercel lit AUSSI `vercel.json` et fusionne les deux.
    // `vercel.json` est donc la source unique, et le build se contente de vérifier.
    const script = readFileSync(resolve(process.cwd(), 'scripts/fix-vercel-output.js'), 'utf8');
    expect(script).toContain('assertCronsAreDeployable');
    // Une expression cron écrite en dur dans le script serait la seconde copie qu'on refuse.
    expect(script).not.toMatch(/schedule:\s*['"][\d*]/);
  });
});
