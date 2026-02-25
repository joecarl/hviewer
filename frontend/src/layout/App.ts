import { component, type Route, Router } from 'chispa';
import tpl from './App.html';

export interface IAppProps {
	routes: Route[];
}

export const App = component<IAppProps>(({ routes }) => {
	return tpl.fragment({
		appRoot: {},
		routerView: {
			inner: Router({ routes }),
		},
	});
});
