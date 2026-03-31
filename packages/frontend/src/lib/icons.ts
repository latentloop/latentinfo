/**
 * Pre-register Iconify Solar icons at build time so the Icon component
 * never fetches from api.iconify.design (blocked by Electron CSP).
 *
 * Import this module once in main.tsx before any rendering.
 */
import { addIcon } from "@iconify/react"

import widget5Bold from "@iconify-icons/solar/widget-5-bold"
import globalBold from "@iconify-icons/solar/global-bold"
import bookBold from "@iconify-icons/solar/book-bold"
import clockCircleBold from "@iconify-icons/solar/clock-circle-bold"
import closeCircleBold from "@iconify-icons/solar/close-circle-bold"
import closeSquareLinear from "@iconify-icons/solar/close-square-linear"
import playBold from "@iconify-icons/solar/play-bold"
import plugCircleBold from "@iconify-icons/solar/plug-circle-bold"
import linkBrokenBold from "@iconify-icons/solar/link-broken-bold"
import folderOpenBold from "@iconify-icons/solar/folder-open-bold"
import squareArrowRightUpBold from "@iconify-icons/solar/square-arrow-right-up-bold"
import copyBold from "@iconify-icons/solar/copy-bold"
import checkCircleBold from "@iconify-icons/solar/check-circle-bold"
import altArrowDownBold from "@iconify-icons/solar/alt-arrow-down-bold"
import altArrowUpBold from "@iconify-icons/solar/alt-arrow-up-bold"
import dangerCircleBold from "@iconify-icons/solar/danger-circle-bold"

addIcon("solar:widget-5-bold", widget5Bold)
addIcon("solar:global-bold", globalBold)
addIcon("solar:book-bold", bookBold)
addIcon("solar:clock-circle-bold", clockCircleBold)
addIcon("solar:close-circle-bold", closeCircleBold)
addIcon("solar:close-square-linear", closeSquareLinear)
addIcon("solar:play-bold", playBold)
addIcon("solar:plug-circle-bold", plugCircleBold)
addIcon("solar:link-broken-bold", linkBrokenBold)
addIcon("solar:folder-open-bold", folderOpenBold)
addIcon("solar:square-arrow-right-up-bold", squareArrowRightUpBold)
addIcon("solar:copy-bold", copyBold)
addIcon("solar:check-circle-bold", checkCircleBold)
addIcon("solar:alt-arrow-down-bold", altArrowDownBold)
addIcon("solar:alt-arrow-up-bold", altArrowUpBold)
addIcon("solar:danger-circle-bold", dangerCircleBold)
