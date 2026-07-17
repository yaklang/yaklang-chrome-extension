import { runBackground } from '@/app/background';

export default defineBackground({
  type: 'module',
  main: runBackground,
});
