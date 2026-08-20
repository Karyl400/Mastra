import { describe, it, expect, vi } from 'vitest';
import {
  CRITICAL_ENV_VARS,
  missingCriticalEnv,
  reportMissingCriticalEnv,
} from '../../../src/shared/startup-env-check';
import { MIN_API_TOKEN_LENGTH } from '../../../src/shared/security/api-auth';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Le démarrage est BRUYANT sur ce qui manque — jamais BLOQUANT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Seul `DATABASE_URL` faisait échouer le boot. Sans `SLACK_SIGNING_SECRET`, sans
 * `SLACK_BOT_TOKEN`, sans `GROQ_API_KEY`, le service démarrait « en vert », acceptait le
 * trafic, et échouait au premier message réel — un mode de panne qui ne se manifeste qu'en
 * production, et dont le symptôme (« le bot ne répond pas ») ne désigne pas sa cause. C'est
 * exactement la famille de défaut que ce dépôt traque ailleurs : un état affirmé sans être
 * constaté.
 *
 * ⚠️ On NE FAIT PAS échouer le boot pour ces variables-là, et c'est un arbitrage, pas une
 * timidité. `DATABASE_URL` est le seul cas où l'échec immédiat se justifie (rien ne peut
 * fonctionner sans base). Lever sur une clé LLM casserait le playground et les tests, et un
 * service qui refuse de démarrer sur une clé de repli manquante est moins disponible que
 * celui qu'on prétend protéger.
 *
 * ⚠️ La CONSÉQUENCE est journalisée avec le nom. « SLACK_SIGNING_SECRET manquant » n'apprend
 * rien à qui lit les logs à 3 h du matin ; « toute requête Slack sera rejetée en 401 » nomme
 * le symptôme qu'il est en train d'observer. C'est la même règle que `degradedSteps`, qui
 * porte le couple QUOI/POURQUOI parce qu'un booléen dit qu'il faut réparer, jamais quoi.
 */
describe('contrôle des variables critiques au démarrage', () => {
  const FULL: NodeJS.ProcessEnv = {
    SLACK_SIGNING_SECRET: 'shhh',
    SLACK_BOT_TOKEN: 'xoxb-test',
    GROQ_API_KEY: 'gsk-test',
    MISTRAL_API_KEY: 'mis-test',
    MASTRA_API_TOKEN: 'x'.repeat(MIN_API_TOKEN_LENGTH),
  };

  describe('la table elle-même', () => {
    it('couvre les clés dont l’absence casse une capacité entière', () => {
      const names = CRITICAL_ENV_VARS.map((v) => v.name);
      expect(names).toContain('SLACK_SIGNING_SECRET');
      expect(names).toContain('SLACK_BOT_TOKEN');
      expect(names).toContain('GROQ_API_KEY');
    });

    it('ne contient PAS DATABASE_URL — son absence est fatale, pas signalée', () => {
      expect(CRITICAL_ENV_VARS.map((v) => v.name)).not.toContain('DATABASE_URL');
    });

    it('nomme une conséquence concrète pour chaque variable, jamais son seul nom', () => {
      for (const entry of CRITICAL_ENV_VARS) {
        expect(entry.consequence.length).toBeGreaterThan(20);
        expect(entry.consequence).not.toBe(entry.name);
      }
    });
  });

  describe('détection', () => {
    it('ne signale rien quand tout est renseigné', () => {
      expect(missingCriticalEnv(FULL)).toEqual([]);
    });

    it('signale une variable absente', () => {
      const { SLACK_BOT_TOKEN: _omit, ...env } = FULL;
      expect(missingCriticalEnv(env).map((v) => v.name)).toEqual(['SLACK_BOT_TOKEN']);
    });

    it('signale une variable vide ou faite d’espaces — un `KEY=` copié tel quel', () => {
      expect(missingCriticalEnv({ ...FULL, GROQ_API_KEY: '' }).map((v) => v.name)).toEqual([
        'GROQ_API_KEY',
      ]);
      expect(missingCriticalEnv({ ...FULL, GROQ_API_KEY: '   ' }).map((v) => v.name)).toEqual([
        'GROQ_API_KEY',
      ]);
    });

    it('signale toutes les absences d’un coup, pas seulement la première', () => {
      expect(
        missingCriticalEnv({})
          .map((v) => v.name)
          .sort(),
      ).toEqual(CRITICAL_ENV_VARS.map((v) => v.name).sort());
    });

    /**
     * `MASTRA_API_TOKEN` est déjà fail-closed : trop court, toutes les routes /api/*
     * répondent 401. Mais le fail-closed est muet pour l'exploitant — il ne parle qu'à
     * l'appelant. Le seuil vient de `api-auth.ts`, il n'est pas recopié : un second littéral
     * finirait par dire autre chose que le premier, et ce serait le jour où quelqu'un s'en
     * sert pour décider.
     */
    it('signale un MASTRA_API_TOKEN présent mais trop court', () => {
      const short = 'x'.repeat(MIN_API_TOKEN_LENGTH - 1);
      expect(missingCriticalEnv({ ...FULL, MASTRA_API_TOKEN: short }).map((v) => v.name)).toEqual([
        'MASTRA_API_TOKEN',
      ]);
    });
  });

  describe('journalisation', () => {
    it('émet une ligne `error` par variable manquante, nom ET conséquence', () => {
      const error = vi.fn();
      const { GROQ_API_KEY: _omit, ...env } = FULL;

      const missing = reportMissingCriticalEnv(env, { error });

      expect(missing.map((v) => v.name)).toEqual(['GROQ_API_KEY']);
      expect(error).toHaveBeenCalledTimes(1);

      const [message, payload] = error.mock.calls[0];
      expect(message).toContain('GROQ_API_KEY');
      expect(JSON.stringify(payload)).toContain('conséquence');
    });

    it('reste MUET quand tout est renseigné — un contrôle qui crie toujours s’ignore', () => {
      const error = vi.fn();
      expect(reportMissingCriticalEnv(FULL, { error })).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ Ne JAMAIS journaliser la valeur d'une clé — seulement sa présence. La règle est
     * écrite dans CLAUDE.md et n'était verrouillée nulle part sur ce chemin-ci, qui est
     * précisément celui qui manipule des clés d'API.
     */
    it('ne journalise JAMAIS la valeur d’une variable, même celles qui sont posées', () => {
      const error = vi.fn();
      reportMissingCriticalEnv({ ...FULL, SLACK_BOT_TOKEN: undefined }, { error });

      const emitted = JSON.stringify(error.mock.calls);
      expect(emitted).not.toContain('gsk-test');
      expect(emitted).not.toContain('mis-test');
      expect(emitted).not.toContain('shhh');
    });
  });
});
