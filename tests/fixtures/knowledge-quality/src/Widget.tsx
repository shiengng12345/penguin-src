import { calculate } from "./math";

export function Widget() {
  return <button onClick={() => calculate(3)}>Calculate</button>;
}
