// Entry point. Importing the modules with side-effect-only handler attachments
// (interaction, keyboard) wires the canvas listeners; the init* calls below
// cover the bits that need explicit ordering.

import "./interaction";
import "./keyboard";

import { initHostMessageHandling, initCanvasDrop } from "./host";
import { initPaletteSections } from "./palette";
import { initToolbar, updateRoutingButton, updateSnapButton } from "./toolbar";
import { render } from "./render";
import { syncColorPickerToSelection } from "./selection";
import { applyView } from "./view";

initToolbar();
initPaletteSections();
initCanvasDrop();
initHostMessageHandling();

applyView();
updateRoutingButton();
updateSnapButton();
syncColorPickerToSelection();
render();
