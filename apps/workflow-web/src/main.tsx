import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/ibm-plex-sans/index.css';
import '@fontsource/ibm-plex-mono/400.css';
import { mockWorkflowPorts } from '@forexplore/mock-adapters';
import { withSeekDbSearch } from '@forexplore/seekdb-adapter';
import { withAdaptationService } from '@forexplore/adaptation-http-adapter';
import {
  csharpWorkspaceId,
  workspaceModuleSymbols,
} from '@forexplore/workspace-adapters';
import App from './App';
import './styles.css';

const retrievalApiUrl = import.meta.env.VITE_RETRIEVAL_API_URL?.trim();
const adaptationApiUrl = import.meta.env.VITE_ADAPTATION_API_URL?.trim();

let workflowPorts = mockWorkflowPorts;
if (retrievalApiUrl) {
  workflowPorts = withSeekDbSearch(workflowPorts, { baseUrl: retrievalApiUrl });
}
if (adaptationApiUrl) {
  workflowPorts = withAdaptationService(workflowPorts, { baseUrl: adaptationApiUrl });
}

async function bootstrap() {
  const moduleTree = await workspaceModuleSymbols.loadTree(csharpWorkspaceId);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App
        ports={workflowPorts}
        moduleTree={moduleTree}
        searchProvider={retrievalApiUrl ? 'SeekDB' : 'Mock'}
      />
    </React.StrictMode>,
  );
}

void bootstrap();
