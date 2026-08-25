import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerServiceWorker } from './browser';
import { App } from './App';
import {
  AGENT_CHAT_ENABLED,
  PRODUCT_BUILD,
  PRODUCT_BUILD_JSON,
  PRODUCT_VARIANT,
  RIBBON_WILD_ENABLED,
  UI_DATA_MODE,
} from './lib/product';
import './surface/runtime';
import './styles/index.css';

document.documentElement.dataset.marksMode = UI_DATA_MODE;
document.documentElement.dataset.marksProductVariant = PRODUCT_VARIANT;
document.documentElement.dataset.marksBuildPlanSha256 = PRODUCT_BUILD.buildPlanSha256;
document.documentElement.dataset.marksRibbonWild = RIBBON_WILD_ENABLED ? 'enabled' : 'disabled';
document.documentElement.dataset.marksAgentChat = AGENT_CHAT_ENABLED ? 'enabled' : 'disabled';

const buildPlan = document.createElement('script');
buildPlan.id = 'marks-product-build';
buildPlan.type = 'application/json';
buildPlan.textContent = PRODUCT_BUILD_JSON.replaceAll('<', '\\u003c');
document.head.append(buildPlan);
registerServiceWorker();

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
