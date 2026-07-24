import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/ibm-plex-sans/index.css';
import '@fontsource/ibm-plex-mono/400.css';
import { mockWorkflowPorts } from '@forexplore/mock-adapters';
import { withSeekDbSearch } from '@forexplore/seekdb-adapter';
import { moduleTree } from 'virtual:target-module-tree';
import App from './App';
import './styles.css';

const retrievalApiUrl = import.meta.env.VITE_RETRIEVAL_API_URL?.trim();
const workflowPorts = retrievalApiUrl
  ? withSeekDbSearch(mockWorkflowPorts, { baseUrl: retrievalApiUrl })
  : mockWorkflowPorts;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App
      ports={workflowPorts}
      moduleTree={moduleTree}
      searchProvider={retrievalApiUrl ? 'SeekDB' : 'Mock'}
    />
  </React.StrictMode>,
);
