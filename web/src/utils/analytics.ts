import ReactGA from "react-ga4";

const GA_MEASUREMENT_ID = "G-0WB1ZJYZPX "; // Ganti punya lu

export const initGA = () => {
  ReactGA.initialize(GA_MEASUREMENT_ID);
};

export const logPageView = () => {
  ReactGA.send({ hitType: "pageview", page: window.location.pathname });
};