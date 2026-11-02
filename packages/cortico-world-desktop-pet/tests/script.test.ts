import { describe, expect, it } from 'vitest';
import { BUBBLE_SPEED_MAX, DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { figurePacks } from '../src/packs.ts';
import { estimateSeconds, parseActions as actionsIn, parseScript as scriptIn, vocabId, INLINE_TAG_MAX } from '../src/script.ts';

// Coo's words, as the body on screen gives them
const VOCAB = figurePacks([]).packs.find((p) => p.id === 'coo')!.manifest.vocab;
const parseScript = (s: string) => scriptIn(s, VOCAB);
const parseActions = (list: unknown[]) => actionsIn(list, VOCAB);

describe('parseScript', () => {
  it('splits bubbles at blocking markers and keeps inline markers at their character offset', () => {
    const { beats, dropped } = parseScript('【开心】你好呀!<眨眼>今天也加油。【jump, 点头】看我!');
    expect(dropped).toEqual([]);
    expect(beats).toEqual([
      { actions: ['happy'], text: '你好呀!今天也加油。', anchors: [{ at: 4, actions: ['wink'] }] },
      { actions: ['jump', 'nod'], text: '看我!', anchors: [] },
    ]);
  });

  it('reports unknown words and drops them', () => {
    const { beats, dropped } = parseScript('【开心,飞起来】好');
    expect(dropped).toEqual(['飞起来']);
    expect(beats[0].actions).toEqual(['happy']);
  });

  it('ignores unsupported actions without splitting a title or ordinary sentence', () => {
    for (const source of ['我搜到B站有个《【梗知识】好女孩》', '前半句【unsupported】后半句']) {
      const parsed = parseScript(source);
      expect(parsed.beats).toHaveLength(1);
      expect(parsed.beats[0].text).toBe(source.replace(/【[^】]*】/g, ''));
      expect(parsed.dropped).toHaveLength(1);
    }
  });

  it('keeps actions inside paired titles, quotes and parentheses inline', () => {
    for (const [open, close] of [['《','》'], ['“','”'], ['「','」'], ['（','）'], ['(',')'], ['"','"']]) {
      const parsed = parseScript(`开头${open}好【开心】女孩${close}接着说【点头】下一句`);
      expect(parsed.beats.map((b) => b.text)).toEqual([`开头${open}好女孩${close}接着说`, '下一句']);
      expect(parsed.beats[0].anchors).toEqual([{ at: `开头${open}好`.length, actions: ['happy'] }]);
      expect(parsed.beats[1].actions).toEqual(['nod']);
    }
  });

  it('preserves nested titles and punctuation without any markers', () => {
    const source = '我搜到《她说“好女孩！”（现场版）》；你看过吗？';
    expect(parseScript(source).beats).toEqual([{ actions: [], text: source, anchors: [] }]);
  });

  it('treats an over-long or multi-line inline marker as text', () => {
    const long = `<${'x'.repeat(INLINE_TAG_MAX + 1)}>`;
    expect(parseScript(`a${long}b`).beats[0].text).toBe(`a${long}b`);
    expect(parseScript('a<开\n心>b').beats[0].text).toBe('a<开\n心>b');
  });

  it('keeps an unclosed blocking marker as text', () => {
    expect(parseScript('你好【开心').beats[0].text).toBe('你好【开心');
  });

  it('allows a beat with actions only', () => {
    expect(parseScript('【sleep】').beats).toEqual([{ actions: ['sleep'], text: '', anchors: [] }]);
  });
});

describe('vocabulary', () => {
  it('resolves every id and every name to the same id', () => {
    for (const v of VOCAB) {
      expect(vocabId(v.id, VOCAB)).toBe(v.id);
      for (const z of Object.values(v.names).flat()) expect(vocabId(z, VOCAB)).toBe(v.id);
    }
  });

  it('parseActions separates known from unknown words', () => {
    expect(parseActions(['跳', 'happy', 'fly', 3])).toEqual({ actions: ['jump', 'happy'], dropped: ['fly', '3'] });
  });

  it('estimates longer display for longer text', () => {
    const speed = DESKTOP_PET_DEFAULTS.window.bubbleSpeed;
    expect(estimateSeconds(parseScript('短').beats, speed)).toBeLessThan(estimateSeconds(parseScript('这是一段明显更长的话,要多打一会儿字才能说完。').beats, speed));
  });

  it('divides the typing and reading time of text by the bubble speed, as the page does', () => {
    const { beats } = parseScript('这是一段明显更长的话,要多打一会儿字才能说完,再多说几句让它停得久一些。');
    expect(estimateSeconds(beats, DESKTOP_PET_DEFAULTS.window.bubbleSpeed) / estimateSeconds(beats, BUBBLE_SPEED_MAX)).toBeCloseTo(BUBBLE_SPEED_MAX / DESKTOP_PET_DEFAULTS.window.bubbleSpeed, 1);
  });
});
