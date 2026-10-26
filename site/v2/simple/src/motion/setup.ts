// Global motion, registered once on the client before the first page initialises.
import { fieldModule } from './field';
import { quietModule } from './quiet';
import { stepsModule } from './steps';
import { uiModule } from './ui';

export function setupMotion() {
  fieldModule();
  quietModule();
  stepsModule();
  uiModule();
}
