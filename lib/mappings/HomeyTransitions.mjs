import { Transitions } from '@matter/main';

// Use Matter's rate, bounds and cyclic-hue calculations, but apply every step to the source first.
export class HomeyTransitions extends Transitions {
  #write;

  constructor(endpoint, config, write) {
    super(endpoint, { ...config, manageTransitions: true });
    this.#write = write;
  }

  async start(transition) {
    const { owner, name, targetValue } = transition;
    const initialValue = owner.state[name];

    try {
      if (initialValue === targetValue) {
        this.stop(name);
        // An unchanged numeric target can still switch color mode or turn a light on/off.
        await this.applyUpdates(owner, { [name]: targetValue });
        return;
      }

      await super.start(transition);

      // Await the first physical write before accepting a continuous command. Later failures stop
      // the SDK's transition timer; they must not keep advancing the reported Matter state.
      if (this.stateOf(name)) {
        await this.step(owner);

        // Slow rates may not change the rounded attribute on the first tick. Still validate the
        // source operation now, including a possible mode change, before accepting the command.
        if (owner.state[name] === initialValue) {
          await this.applyUpdates(owner, { [name]: initialValue });
        }
      }
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  async applyUpdates(behavior, changes) {
    await this.#write(behavior, changes);
    return super.applyUpdates(behavior, changes);
  }
}
