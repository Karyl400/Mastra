import { describe, it, expect } from 'vitest';
import { hasNoTextualContent } from '../../../src/shared/message-shape';

/**
 * Le critère est « ce message contient-il quoi que ce soit qu'un modèle puisse traiter ? »,
 * et la réponse doit être NON pour tout ce qui ne porte aucune lettre ni aucun chiffre.
 *
 * L'enjeu est un budget : un message sans contenu textuel déclenchait un run LLM complet,
 * mesuré à ≈ 5 000 tokens sur la campagne du 2026-08-11, soit ≈ 5 % du quota Groq quotidien
 * (100 000 tokens/jour, ≈ 19 messages). Pour un emoji.
 */
describe('hasNoTextualContent', () => {
  it('reconnaît un message uniquement composé d’emojis', () => {
    expect(hasNoTextualContent('😀')).toBe(true);
    expect(hasNoTextualContent('🎉🎉🎉')).toBe(true);
    expect(hasNoTextualContent('👍')).toBe(true);
  });

  it('reconnaît un message uniquement composé de ponctuation', () => {
    expect(hasNoTextualContent('???')).toBe(true);
    expect(hasNoTextualContent('...')).toBe(true);
    expect(hasNoTextualContent('!!!')).toBe(true);
    expect(hasNoTextualContent('?!')).toBe(true);
  });

  it('reconnaît un kaomoji fait de seuls symboles', () => {
    expect(hasNoTextualContent('(╯°□°)╯')).toBe(true);
    expect(hasNoTextualContent('^_^')).toBe(true);
    expect(hasNoTextualContent(':-)')).toBe(true);
  });

  /**
   * ⚠️ ARBITRAGE ASSUMÉ, et il va dans le sens du faux négatif. `¯\_(ツ)_/¯` contient « ツ »,
   * qui EST une lettre katakana : le message atteint donc le modèle et coûte un run.
   *
   * L'alternative serait d'exclure les alphabets CJK de la définition de « lettre » — ce qui
   * rendrait le bot muet devant « 你好 » et « こんにちは ». On préfère payer quelques tokens
   * sur un haussement d'épaules que de ne pas répondre à quelqu'un qui écrit en japonais.
   */
  it('LAISSE PASSER un kaomoji contenant une vraie lettre', () => {
    expect(hasNoTextualContent('¯\\_(ツ)_/¯')).toBe(false);
  });

  it('reconnaît le vide et les espaces', () => {
    expect(hasNoTextualContent('')).toBe(true);
    expect(hasNoTextualContent('   ')).toBe(true);
    expect(hasNoTextualContent('\n\n\t')).toBe(true);
    expect(hasNoTextualContent(undefined)).toBe(true);
    expect(hasNoTextualContent(null)).toBe(true);
  });

  /**
   * ⚠️ C'est le faux positif qui coûterait cher : il rendrait le bot MUET sur une vraie
   * demande. Chaque cas ci-dessous doit atteindre le modèle.
   */
  it('laisse passer tout message portant la moindre lettre ou le moindre chiffre', () => {
    expect(hasNoTextualContent('ok')).toBe(false);
    expect(hasNoTextualContent('non')).toBe(false);
    expect(hasNoTextualContent('123')).toBe(false);
    expect(hasNoTextualContent('👍 merci')).toBe(false);
    expect(hasNoTextualContent('😀 où en est mon dossier ?')).toBe(false);
  });

  /**
   * Les alphabets NON LATINS portent du sens : les traiter comme du vide rendrait le bot
   * muet pour quiconque écrit en arabe, en russe ou en chinois. Le critère est donc
   * « lettre Unicode », jamais « lettre a-z ».
   */
  it('laisse passer les alphabets non latins', () => {
    expect(hasNoTextualContent('مرحبا')).toBe(false);
    expect(hasNoTextualContent('привет')).toBe(false);
    expect(hasNoTextualContent('你好')).toBe(false);
    expect(hasNoTextualContent('こんにちは')).toBe(false);
    expect(hasNoTextualContent('Καλημέρα')).toBe(false);
  });

  it('laisse passer les lettres accentuées', () => {
    expect(hasNoTextualContent('à')).toBe(false);
    expect(hasNoTextualContent('où ?')).toBe(false);
  });
});

/**
 * `'?'` seul est volontairement LAISSÉ PASSER par `hasNoTextualContent` puisqu'il ne porte
 * aucune lettre — ce test documente que le choix est bien l'inverse, et pourquoi.
 */
describe('hasNoTextualContent — le cas « ? » seul', () => {
  it('« ? » seul est traité comme sans contenu', () => {
    // Un point d'interrogation seul n'est pas une demande : c'est une réaction. Le modèle
    // ne peut rien en faire d'autre que redemander ce que la personne veut — ce que la
    // réponse déterministe fait pour zéro token.
    expect(hasNoTextualContent('?')).toBe(true);
  });
});
