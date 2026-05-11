import { GlobalRegistrator } from '@happy-dom/global-registrator';
// Register with an explicit URL so history.pushState can update
// location.pathname / location.search inside tests. Without this happy-dom
// initializes location as `about:blank`, and pushState becomes a no-op for the
// pathname/search getters — tests that key behavior off cvCacheKey() (which
// reads pathname+search) would silently misbehave.
GlobalRegistrator.register({ url: 'http://localhost/' });
