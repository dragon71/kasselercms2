(function(tinymce) {
	var VK = tinymce.VK, BACKSPACE = VK.BACKSPACE, DELETE = VK.DELETE;

	/**
	 * Executes a command with a specific state this can be to enable/disable browser editing features.
	 */
	function setEditorCommandState(editor, cmd, state) {
		try {
			editor.getDoc().execCommand(cmd, false, state);
		} catch (ex) {
			// Ignore
		}
	}

	/**
	 * Fixes a WebKit bug when deleting contents using backspace or delete key.
	 * WebKit will produce a span element if you delete across two block elements.
	 *
	 * Example:
	 * <h1>a</h1><p>|b</p>
	 *
	 * Will produce this on backspace:
	 * <h1>a<span class="Apple-style-span" style="<all runtime styles>">b</span></p>
	 *
	 * This fixes the backspace to produce:
	 * <h1>a|b</p>
	 *
	 * See bug: https://bugs.webkit.org/show_bug.cgi?id=45784
	 *
	 * This code is a bit of a hack and hopefully it will be fixed soon in WebKit.
	 */
	function cleanupStylesWhenDeleting(ed) {
		var dom = ed.dom, selection = ed.selection;

		ed.onKeyDown.add(function(ed, e) {
			var rng, blockElm, node, clonedSpan, isDelete;

			if (e.isDefaultPrevented()) {
				return;
			}

			isDelete = e.keyCode == DELETE;
			if ((isDelete || e.keyCode == BACKSPACE) && !VK.modifierPressed(e)) {
				e.preventDefault();
				rng = selection.getRng();

				// Find root block
				blockElm = dom.getParent(rng.startContainer, dom.isBlock);

				// On delete clone the root span of the next block element
				if (isDelete)
					blockElm = dom.getNext(blockElm, dom.isBlock);

				// Locate root span element and clone it since it would otherwise get merged by the "apple-style-span" on delete/backspace
				if (blockElm) {
					node = blockElm.firstChild;

					// Ignore empty text nodes
					while (node && node.nodeType == 3 && node.nodeValue.length == 0)
						node = node.nextSibling;

					if (node && node.nodeName === 'SPAN') {
						clonedSpan = node.cloneNode(false);
					}
				}

				// Do the backspace/delete action
				ed.getDoc().execCommand(isDelete ? 'ForwardDelete' : 'Delete', false, null);

				// Find all odd apple-style-spans
				blockElm = dom.getParent(rng.startContainer, dom.isBlock);
				tinymce.each(dom.select('span.Apple-style-span,font.Apple-style-span', blockElm), function(span) {
					var bm = selection.getBookmark();

					if (clonedSpan) {
						dom.replace(clonedSpan.cloneNode(false), span, true);
					} else {
						dom.remove(span, true);
					}

					// Restore the selection
					selection.moveToBookmark(bm);
				});
			}
		});
	};

	/**
	 * WebKit and IE doesn't empty the editor if you select all contents and hit backspace or delete. This fix will check if the body is empty
	 * like a <h1></h1> or <p></p> and then forcefully remove all contents.
	 */
	function emptyEditorWhenDeleting(ed) {
		function serializeRng(rng) {
			var body = ed.dom.create("body");
			var contents = rng.cloneContents();
			body.appendChild(contents);
			return ed.selection.serializer.serialize(body, {format: 'html'});
		}

		function allContentsSelected(rng) {
			var selection = serializeRng(rng);

			var allRng = ed.dom.createRng();
			allRng.selectNode(ed.getBody());

			var allSelection = serializeRng(allRng);
			return selection === allSelection;
		}

		ed.onKeyDown.addToTop(function(ed, e) {
			var keyCode = e.keyCode;
			if (keyCode == DELETE || keyCode == BACKSPACE) {
				var rng = ed.selection.getRng(true);
				if (!rng.collapsed && allContentsSelected(rng)) {
					ed.setContent('', {format : 'raw'});
					ed.nodeChanged();
					e.preventDefault();
				}
			}
		});
	};

	/**
	 * WebKit on MacOS X has a weird issue where it some times fails to properly convert keypresses to input method keystrokes.
	 * So a fix where we just get the range and set the range back seems to do the trick.
	 */
	function inputMethodFocus(ed) {
		ed.dom.bind(ed.getDoc(), 'focusin', function() {
			ed.selection.setRng(ed.selection.getRng());
		});
	};

	/**
	 * Backspacing in FireFox/IE from a paragraph into a horizontal rule results in a floating text node because the
	 * browser just deletes the paragraph - the browser fails to merge the text node with a horizontal rule so it is
	 * left there. TinyMCE sees a floating text node and wraps it in a paragraph on the key up event (ForceBlocks.js
	 * addRootBlocks), meaning the action does nothing. With this code, FireFox/IE matche the behaviour of other
     * browsers
	 */
	function removeHrOnBackspace(ed) {
		ed.onKeyDown.add(function(ed, e) {
			if (e.keyCode === BACKSPACE) {
				if (ed.selection.isCollapsed() && ed.selection.getRng(true).startOffset === 0) {
					var node = ed.selection.getNode();
					var previousSibling = node.previousSibling;
					if (previousSibling && previousSibling.nodeName && previousSibling.nodeName.toLowerCase() === "hr") {
						ed.dom.remove(previousSibling);
						tinymce.dom.Event.cancel(e);
					}
				}
			}
		})
	}

	/**
	 * Firefox 3.x has an issue where the body element won't get proper focus if you click out
	 * side it's rectangle.
	 */
	function focusBody(ed) {
		// Fix for a focus bug in FF 3.x where the body element
		// wouldn't get proper focus if the user clicked on the HTML element
		if (!Range.prototype.getClientRects) { // Detect getClientRects got introduced in FF 4
			ed.onMouseDown.add(function(ed, e) {
				if (e.target.nodeName === "HTML") {
					var body = ed.getBody();

					// Blur the body it's focused but not correctly focused
					body.blur();

					// Refocus the body after a little while
					setTimeout(function() {
						body.focus();
					}, 0);
				}
			});
		}
	};

	/**
	 * WebKit has a bug where it isn't possible to select image, hr or anchor elements
	 * by clicking on them so we need to fake that.
	 */
	function selectControlElements(ed) {
		ed.onClick.add(function(ed, e) {
			e = e.target;

			// Workaround for bug, http://bugs.webkit.org/show_bug.cgi?id=12250
			// WebKit can't even do simple things like selecting an image
			// Needs tobe the setBaseAndExtend or it will fail to select floated images
			if (/^(IMG|HR)$/.test(e.nodeName))
				ed.selection.getSel().setBaseAndExtent(e, 0, e, 1);

			if (e.nodeName == 'A' && ed.dom.hasClass(e, 'mceItemAnchor'))
				ed.selection.select(e);

			ed.nodeChanged();
		});
	};

	/**
	 * Fixes a Gecko bug where the style attribute gets added to the wrong element when deleting between two block elements.
	 */
	function removeStylesWhenDeletingAccrossBlockElements(ed) {
		var selection = ed.selection, dom = ed.dom;

		function getAttributeApplyFunction() {
			var template = dom.getAttribs(selection.getStart().cloneNode(false));

			return function() {
				var target = selection.getStart();

				if (target !== ed.getBody()) {
					dom.setAttrib(target, "style", null);

				tinymce.each(template, function(attr) {
					target.setAttributeNode(attr.cloneNode(true));
				});
				}
			};
		}

		function isSelectionAcrossElements() {
			return !selection.isCollapsed() && selection.getStart() != selection.getEnd();
		}

		function blockEvent(ed, e) {
			e.preventDefault();
			return false;
		}

		ed.onKeyPress.add(function(ed, e) {
			var applyAttributes;

			if ((e.keyCode == 8 || e.keyCode == 46) && isSelectionAcrossElements()) {
				applyAttributes = getAttributeApplyFunction();
				ed.getDoc().execCommand('delete', false, null);
				applyAttributes();
				e.preventDefault();
				return false;
			}
		});

		dom.bind(ed.getDoc(), 'cut', function(e) {
			var applyAttributes;

			if (isSelectionAcrossElements()) {
				applyAttributes = getAttributeApplyFunction();
				ed.onKeyUp.addToTop(blockEvent);

				setTimeout(function() {
					applyAttributes();
					ed.onKeyUp.remove(blockEvent);
				}, 0);
			}
		});
	}
	
	/**
	 * If you hit enter from a heading in IE, the resulting P tag below it shares the style property (bad)
	 * */
	 /*
	function removeStylesOnPTagsInheritedFromHeadingTag(ed) {
		ed.onKeyDown.add(function(ed, event) {
			function checkInHeadingTag(ed) {
				var currentNode = ed.selection.getNode();
				var headingTags = 'h1,h2,h3,h4,h5,h6';
				return ed.dom.is(currentNode, headingTags) || ed.dom.getParent(currentNode, headingTags) !== null;
			}

			if (event.keyCode === VK.ENTER && !VK.modifierPressed(event) && checkInHeadingTag(ed)) {
				setTimeout(function() {
					var currentNode = ed.selection.getNode();
					if (ed.dom.is(currentNode, 'p')) {
						ed.dom.setAttrib(currentNode, 'style', null);
						// While tiny's content is correct after this method call, the content shown is not representative of it and needs to be 'repainted'
						ed.execCommand('mceCleanup');
					}
				}, 0);
			}
		});
	}
	*/

	/**
	 * Fire a nodeChanged when the selection is changed on WebKit this fixes selection issues on iOS5. It only fires the nodeChange
	 * event every 50ms since it would other wise update the UI when you type and it hogs the CPU.
	 */
	function selectionChangeNodeChanged(ed) {
		var lastRng, selectionTimer;

		ed.dom.bind(ed.getDoc(), 'selectionchange', function() {
			if (selectionTimer) {
				clearTimeout(selectionTimer);
				selectionTimer = 0;
			}

			selectionTimer = window.setTimeout(function() {
				var rng = ed.selection.getRng();

				// Compare the ranges to see if it was a real change or not
				if (!lastRng || !tinymce.dom.RangeUtils.compareRanges(rng, lastRng)) {
					ed.nodeChanged();
					lastRng = rng;
				}
			}, 50);
		});
	}

	/**
	 * Screen readers on IE needs to have the role application set on the body.
	 */
	function ensureBodyHasRoleApplication(ed) {
		document.body.setAttribute("role", "application");
	}
	
	/**
	 * Backspacing into a table behaves differently depending upon browser type.
	 * Therefore, disable Backspace when cursor immediately follows a table.
	 */
	function disableBackspaceIntoATable(ed) {
		ed.onKeyDown.add(function(ed, e) {
			if (e.keyCode === BACKSPACE) {
				if (ed.selection.isCollapsed() && ed.selection.getRng(true).startOffset === 0) {
					var previousSibling = ed.selection.getNode().previousSibling;
					if (previousSibling && previousSibling.nodeName && previousSibling.nodeName.toLowerCase() === "table") {
						return tinymce.dom.Event.cancel(e);
					}
				}
			}
		})
	}

	/**
	 * Old IE versions can't properly render BR elements in PRE tags white in contentEditable mode. So this logic adds a \n before the BR so that it will get rendered.
	 */
	function addNewLinesBeforeBrInPre(editor) {
		var documentMode = editor.getDoc().documentMode;

		// IE8+ rendering mode does the right thing with BR in PRE
		if (documentMode && documentMode > 7) {
			return;
		}

		 // Enable display: none in area and add a specific class that hides all BR elements in PRE to
		 // avoid the caret from getting stuck at the BR elements while pressing the right arrow key
		setEditorCommandState(editor, 'RespectVisibilityInDesign', true);
		editor.dom.addClass(editor.getBody(), 'mceHideBrInPre');

		// Adds a \n before all BR elements in PRE to get them visual
		editor.parser.addNodeFilter('pre', function(nodes, name) {
			var i = nodes.length, brNodes, j, brElm, sibling;

			while (i--) {
				brNodes = nodes[i].getAll('br');
				j = brNodes.length;
				while (j--) {
					brElm = brNodes[j];

					// Add \n before BR in PRE elements on older IE:s so the new lines get rendered
					sibling = brElm.prev;
					if (sibling && sibling.type === 3 && sibling.value.charAt(sibling.value - 1) != '\n') {
						sibling.value += '\n';
					} else {
						brElm.parent.insert(new tinymce.html.Node('#text', 3), brElm, true).value = '\n';
					}
				}
			}
		});

		// Removes any \n before BR elements in PRE since other browsers and in contentEditable=false mode they will be visible
		editor.serializer.addNodeFilter('pre', function(nodes, name) {
			var i = nodes.length, brNodes, j, brElm, sibling;

			while (i--) {
				brNodes = nodes[i].getAll('br');
				j = brNodes.length;
				while (j--) {
					brElm = brNodes[j];
					sibling = brElm.prev;
					if (sibling && sibling.type == 3) {
						sibling.value = sibling.value.replace(/\r?\n$/, '');
					}
				}
			}
		});
	}

	tinymce.create('tinymce.util.Quirks', {
		Quirks: function(ed) {
			// All browsers
			disableBackspaceIntoATable(ed);

			// WebKit
			if (tinymce.isWebKit) {
				cleanupStylesWhenDeleting(ed);
				emptyEditorWhenDeleting(ed);
				inputMethodFocus(ed);
				selectControlElements(ed);

				// iOS
				if (tinymce.isIDevice) {
					selectionChangeNodeChanged(ed);
				}
			}

			// IE
			if (tinymce.isIE) {
				removeHrOnBackspace(ed);
				emptyEditorWhenDeleting(ed);
				ensureBodyHasRoleApplication(ed);
				//removeStylesOnPTagsInheritedFromHeadingTag(ed)
				addNewLinesBeforeBrInPre(ed);
			}

			// Gecko
			if (tinymce.isGecko) {
				removeHrOnBackspace(ed);
				focusBody(ed);
				removeStylesWhenDeletingAccrossBlockElements(ed);
			}
		}
	});
})(tinymce);
