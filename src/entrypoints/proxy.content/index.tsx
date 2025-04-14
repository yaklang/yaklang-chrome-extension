import './App.css';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';

export default defineContentScript({
    matches: ['<all_urls>'],
    cssInjectionMode: 'ui',


    async main(ctx) {
        console.log("Proxy content script starting...");

        // Define your UI with shadow root for isolation
        const ui = await createShadowRootUi(ctx, {
            name: 'yakit-proxy-panel',
            position: 'inline',
            anchor: 'body',
            onMount: (container) => {
                // Create a wrapper div for the React app
                const app = document.createElement('div');
                app.id = 'yakit-proxy-root';
                app.className = 'yak-proxy-root';
                container.append(app);

                // Create a root on the UI container and render a component
                const root = ReactDOM.createRoot(app);
                root.render(<App />);
                return root;
            },
            onRemove: (root) => {
                // Unmount the root when the UI is removed
                root?.unmount();
            },
        });

        // Mount the UI
        ui.mount();
    },
});
