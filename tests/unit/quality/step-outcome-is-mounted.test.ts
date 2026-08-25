import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * UNE MARQUE ÉCRITE N'EST PAS UNE MARQUE POSÉE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Même leçon que `guards-are-mounted.test.ts`, sur un autre objet : `markStepOutcomes` peut
 * être parfait et ne servir à rien s'il n'enveloppe pas les outils que les agents reçoivent.
 *
 * ⚠️ **LE POINT DE MONTAGE EST LA FABRIQUE D'AGENT, PAS `src/mastra/index.ts`** — et c'est ce
 * qui rend ce lot DÉRIVÉ. Les quatre agents reçoivent tous leur `tools` par injection et le
 * passent tel quel à `new Agent`. Envelopper là, c'est couvrir TOUT outil câblé sur TOUT
 * agent, aujourd'hui et demain, sans liste à tenir. Envelopper au câblage aurait exigé
 * d'énumérer treize constantes — la forme même que ce dépôt a déjà payée avec la constante
 * `WIRING` recopiée et dérivée en silence.
 */

const ROOT = resolve(__dirname, '../../..');
const FEATURES = join(ROOT, 'src/features');

function agentFactories(): string[] {
  const found: string[] = [];
  for (const feature of readdirSync(FEATURES)) {
    const dir = join(FEATURES, feature, 'application/agents');
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) if (file.endsWith('.ts')) found.push(join(dir, file));
  }
  return found.sort();
}

describe('tout agent pose la marque d’issue sur ses outils', () => {
  const factories = agentFactories();

  it('les quatre agents exposés sont bien trouvés', () => {
    expect(factories.map((file) => relative(FEATURES, file))).toEqual([
      'knowledge/application/agents/knowledge-agent.ts',
      'notification/application/agents/notification-agent.ts',
      'onboarding/application/agents/onboarding-orchestrator.ts',
      'recruitment/application/agents/recruitment-agent.ts',
    ]);
  });

  for (const file of factories) {
    const name = relative(ROOT, file);

    it(`${name} passe ses outils par markStepOutcomes`, () => {
      const source = readFileSync(file, 'utf-8');

      expect(source).toContain('markStepOutcomes');
      expect(source).toMatch(/tools:\s*markStepOutcomes\(/);
      expect(source).not.toMatch(/tools:\s*tools\s*,/);
    });
  }
});
