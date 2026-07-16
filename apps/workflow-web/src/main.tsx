import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/ibm-plex-sans/index.css';
import '@fontsource/ibm-plex-mono/400.css';
import { mockWorkflowPorts, moduleTree } from '@forexplore/mock-adapters';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App ports={mockWorkflowPorts} moduleTree={moduleTree} />
  </React.StrictMode>,
);
