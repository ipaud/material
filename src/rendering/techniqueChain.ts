/** Render ordered, stateless stages through two distinct ping-pong targets. */
export interface TechniqueChainTarget<Texture> {
  readonly texture: Texture;
}

export function renderTechniqueChain<Texture, Target extends TechniqueChainTarget<Texture>, Stage>(
  source: Texture | null,
  stages: readonly Stage[],
  targets: readonly [Target, Target],
  renderPass: (stage: Stage, input: Texture | null, output: Target) => void,
  finalTarget?: Target,
): Texture {
  if (stages.length < 1 || stages.length > 3) {
    throw new RangeError('Technique chains support 1–3 stages');
  }
  if (targets[0].texture === targets[1].texture) {
    throw new Error('Technique chain ping-pong targets must be distinct');
  }

  let input: Texture | null = source;
  for (const [index, stage] of stages.entries()) {
    const isLast = index === stages.length - 1;
    const output = isLast && finalTarget
      ? finalTarget
      : targets.find((target) => target.texture !== input);
    if (!output) throw new Error('Technique chain cannot sample from its output target');
    if (output.texture === input) throw new Error('Technique chain cannot sample from its output target');
    renderPass(stage, input, output);
    input = output.texture;
  }
  if (input === null) throw new Error('Technique chain produced no output texture');
  return input;
}
