import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerServiceWorker } from './browser';
import { App } from './App';
import { AGENT_CHAT_ENABLED, RIBBON_WILD_ENABLED, UI_DATA_MODE } from './lib/product';
import './surface/runtime';
import './styles/index.css';

document.documentElement.dataset.marksMode = UI_DATA_MODE;
document.documentElement.dataset.marksRibbonWild = RIBBON_WILD_ENABLED ? 'enabled' : 'disabled';
document.documentElement.dataset.marksAgentChat = AGENT_CHAT_ENABLED ? 'enabled' : 'disabled';
registerServiceWorker();

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
