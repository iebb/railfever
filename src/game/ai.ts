// AI competitors: companies that plan and build bus networks and intercity railways.
// (Contract stub — the full planner is implemented separately.)
import type { Game } from './game';

export const AI_NAMES = ['Northern Star Rail', 'Blue Valley Transit', 'Crimson Express', 'Evergreen Lines'];

export interface AIState { phase: string; cooldown: number; projects: number }

export class AIController {
  state: AIState = { phase: 'idle', cooldown: 10, projects: 0 };
  constructor(public game: Game, public companyId: number) {}
  /** Called once per game day while AI is enabled. */
  daily() {}
  /** Called once per game month while AI is enabled. */
  monthly() {}
  toJSON(): unknown { return { companyId: this.companyId, state: this.state }; }
  load(data: any) { if (data?.state) this.state = { ...this.state, ...data.state }; }
}
