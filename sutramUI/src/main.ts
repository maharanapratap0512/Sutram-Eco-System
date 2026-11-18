import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { AppModule } from './app/app.module';

console.log('[sutramUI] Starting Angular bootstrap...');

platformBrowserDynamic().bootstrapModule(AppModule)
  .then(() => {
    console.log('[sutramUI] ✓ Angular AppModule bootstrapped successfully!');
  })
  .catch(err => {
    console.error('[sutramUI] Bootstrap error:', err);
    const div = document.createElement('div');
    div.id = 'bootstrap-error-box';
    div.style.cssText = 'color: #b91c1c; background: #fee2e2; border: 2px solid #ef4444; padding: 24px; font-family: monospace; border-radius: 8px; margin: 24px; white-space: pre-wrap; font-size: 14px; z-index: 999999; position: relative;';
    div.innerText = '⚠️ SutramUI Angular Bootstrap Failed:\n\n' + (err?.message || err) + '\n\n' + (err?.stack || '');
    document.body.prepend(div);
  });

