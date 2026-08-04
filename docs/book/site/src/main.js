import { createApp } from 'vue';

import App from './App.vue';
import router from './router.js';
import './styles/tokens.css';
import './styles/controls.css';
import './styles/code.css';
import './styles/prose.css';

createApp(App).use(router).mount('#app');
